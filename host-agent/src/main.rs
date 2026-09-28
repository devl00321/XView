use anyhow::Result;
use arboard::Clipboard;
use enigo::{Coordinate, Enigo, Key, Keyboard, Mouse, Settings};
use futures::{SinkExt, StreamExt};
use shared::{ClipboardMessage, ControlMessage, FileTransferMessage, MouseButton, SignalingMessage};
use std::{fs::File, io::{Cursor, Write}, sync::{Arc, Mutex}, time::Duration};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use tracing::{error, info};
use webrtc::{
    api::{
        interceptor_registry::register_default_interceptors, media_engine::MediaEngine, APIBuilder,
    },
    data_channel::data_channel_message::DataChannelMessage,
    ice_transport::{
        ice_candidate::{RTCIceCandidate, RTCIceCandidateInit},
        ice_server::RTCIceServer,
    },
    interceptor::registry::Registry,
    peer_connection::{
        configuration::RTCConfiguration, peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription, RTCPeerConnection,
    },
};
use xcap::Monitor;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    info!("Starting Host Agent...");

    // Basic hardcoded config for MVP
    let device_id = "test-host-123".to_string();
    let token = "secure-token".to_string();
    let url = std::env::var("SIGNALING_URL").unwrap_or_else(|_| "ws://127.0.0.1:8080/ws".to_string());

    loop {
        if let Err(e) = run_agent(&device_id, &token, &url).await {
            error!("Agent error: {}. Reconnecting in 5s...", e);
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }
}

async fn run_agent(device_id: &str, token: &str, url: &str) -> Result<()> {
    info!("Connecting to signaling server at {}", url);
    let (ws_stream, _) = connect_async(url).await?;
    info!("Connected to signaling server!");

    let (mut write, mut read) = ws_stream.split();

    let reg_msg = SignalingMessage::RegisterHost {
        device_id: device_id.to_string(),
        token: token.to_string(),
        jwt: String::new(),
    };
    write
        .send(Message::Text(serde_json::to_string(&reg_msg)?.into()))
        .await?;

    let (ws_tx, mut ws_rx) = mpsc::channel::<SignalingMessage>(100);

    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = ws_rx.recv().await {
            let json = serde_json::to_string(&msg).unwrap();
            if write.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

    let mut peer_connection: Option<Arc<RTCPeerConnection>> = None;

    while let Some(Ok(msg)) = read.next().await {
        if let Message::Text(text) = msg {
            if let Ok(sig_msg) = serde_json::from_str::<SignalingMessage>(&text) {
                match sig_msg {
                    SignalingMessage::RegistrationSuccess => {
                        info!("Successfully registered as Host! Device ID: {}", device_id);
                    }
                    SignalingMessage::SdpOffer(offer) => {
                        info!("Received SDP Offer!");

                        let mut m = MediaEngine::default();
                        m.register_default_codecs()?;
                        let mut registry = Registry::new();
                        registry = register_default_interceptors(registry, &mut m)?;
                        let api = APIBuilder::new()
                            .with_media_engine(m)
                            .with_interceptor_registry(registry)
                            .build();

                        let config = RTCConfiguration {
                            ice_servers: vec![RTCIceServer {
                                urls: vec!["stun:stun.l.google.com:19302".to_owned()],
                                ..Default::default()
                            }],
                            ..Default::default()
                        };

                        let pc = Arc::new(api.new_peer_connection(config).await?);
                        let pc_clone = Arc::clone(&pc);
                        let ws_tx_clone = ws_tx.clone();

                        pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
                            let ws_tx = ws_tx_clone.clone();
                            Box::pin(async move {
                                if let Some(candidate) = c {
                                    if let Ok(json) =
                                        serde_json::to_string(&candidate.to_json().unwrap())
                                    {
                                        let _ = ws_tx
                                            .send(SignalingMessage::IceCandidate(json))
                                            .await;
                                    }
                                }
                            })
                        }));

                        pc.on_peer_connection_state_change(Box::new(
                            move |s: RTCPeerConnectionState| {
                                info!("Peer Connection State has changed: {}", s);
                                Box::pin(async {})
                            },
                        ));

                        pc.on_data_channel(Box::new(move |d| {
                            let d_label = d.label().to_owned();
                            let d_id = d.id();
                            info!("New DataChannel {} {}", d_label, d_id);

                            let d2 = Arc::clone(&d);

                            let d_label_msg = d_label.clone();
                            let d_label_open = d_label.clone();
                            d.on_open(Box::new(move || {
                                info!("DataChannel '{}'-'{}' open.", d_label_open, d_id);

                                if d_label_open == "video" {
                                    let dc = Arc::clone(&d2);
                                    tokio::spawn(async move {
                                        stream_video(dc).await;
                                    });
                                }

                                Box::pin(async {})
                            }));

                            let d_label_msg = d_label.clone();
                            let current_file: Arc<Mutex<Option<File>>> = Arc::new(Mutex::new(None));
                            
                            d.on_message(Box::new(move |msg: DataChannelMessage| {
                                if d_label_msg == "control" {
                                    handle_control_message(&msg.data);
                                } else if d_label_msg == "file_transfer" {
                                    handle_file_transfer_message(&msg.data, Arc::clone(&current_file));
                                } else if d_label_msg == "clipboard" {
                                    handle_clipboard_message(&msg.data);
                                }
                                Box::pin(async {})
                            }));

                            Box::pin(async {})
                        }));

                        let sdp = RTCSessionDescription::offer(offer)?;
                        pc.set_remote_description(sdp).await?;

                        let answer = pc.create_answer(None).await?;
                        let _gather_complete = pc.gathering_complete_promise().await;
                        pc.set_local_description(answer.clone()).await?;

                        ws_tx
                            .send(SignalingMessage::SdpAnswer(answer.sdp))
                            .await?;

                        peer_connection = Some(pc_clone);
                    }
                    SignalingMessage::IceCandidate(candidate_str) => {
                        if let Some(pc) = &peer_connection {
                            if let Ok(candidate) =
                                serde_json::from_str::<RTCIceCandidateInit>(&candidate_str)
                            {
                                if let Err(e) = pc.add_ice_candidate(candidate).await {
                                    error!("Failed to add ICE candidate: {}", e);
                                }
                            }
                        }
                    }
                    SignalingMessage::PeerDisconnected => {
                        info!("Client disconnected.");
                        if let Some(pc) = peer_connection.take() {
                            let _ = pc.close().await;
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    send_task.abort();
    Ok(())
}

async fn stream_video(dc: Arc<webrtc::data_channel::RTCDataChannel>) {
    info!("Starting video stream...");
    let monitors = Monitor::all().unwrap_or_default();
    let monitor = monitors.first().cloned();

    if let Some(monitor) = monitor {
        loop {
            if dc.ready_state() != webrtc::data_channel::data_channel_state::RTCDataChannelState::Open {
                break;
            }

            match monitor.capture_image() {
                Ok(image) => {
                    let mut buffer = Cursor::new(Vec::new());
                    // Convert Rgba8 to Rgb8 because Jpeg encoder doesn't support Rgba8
                    let rgb_image = image::DynamicImage::ImageRgba8(image).into_rgb8();
                    if let Err(e) = rgb_image.write_to(&mut buffer, image::ImageFormat::Jpeg) {
                        error!("Failed to encode image: {}", e);
                        continue;
                    }

                    // Prepend timestamp or metadata if needed, but for MVP just send the raw JPEG bytes
                    if let Err(e) = dc.send(&bytes::Bytes::from(buffer.into_inner())).await {
                        error!("Failed to send video frame: {}", e);
                        break; // Stop if channel is closed
                    }
                }
                Err(e) => {
                    error!("Failed to capture screen: {}", e);
                }
            }

            // ~15 FPS target
            tokio::time::sleep(Duration::from_millis(66)).await;
        }
    } else {
        error!("No monitors found for screen capture!");
    }
    info!("Video stream ended.");
}

fn handle_control_message(data: &[u8]) {
    if let Ok(msg_str) = std::str::from_utf8(data) {
        if let Ok(ctrl_msg) = serde_json::from_str::<ControlMessage>(msg_str) {
            let mut enigo = Enigo::new(&Settings::default()).unwrap();
            match ctrl_msg {
                ControlMessage::MouseMove { x, y } => {
                    let _ = enigo.move_mouse(x, y, Coordinate::Abs);
                }
                ControlMessage::MouseDown { button } => {
                    let btn = match button {
                        MouseButton::Left => enigo::Button::Left,
                        MouseButton::Right => enigo::Button::Right,
                        MouseButton::Middle => enigo::Button::Middle,
                    };
                    let _ = enigo.button(btn, enigo::Direction::Press);
                }
                ControlMessage::MouseUp { button } => {
                    let btn = match button {
                        MouseButton::Left => enigo::Button::Left,
                        MouseButton::Right => enigo::Button::Right,
                        MouseButton::Middle => enigo::Button::Middle,
                    };
                    let _ = enigo.button(btn, enigo::Direction::Release);
                }
                ControlMessage::MouseScroll { dx, dy } => {
                    let _ = enigo.scroll(dx, enigo::Axis::Horizontal);
                    let _ = enigo.scroll(dy, enigo::Axis::Vertical);
                }
                ControlMessage::KeyPress { key } => {
                    // Very basic key handling for MVP
                    if key.len() == 1 {
                        if let Some(c) = key.chars().next() {
                            let _ = enigo.key(Key::Unicode(c), enigo::Direction::Click);
                        }
                    }
                }
                ControlMessage::KeyRelease { .. } => {
                    // Implement release logic if we change enigo Direction to Press/Release
                }
            }
        }
    }
}

fn handle_file_transfer_message(data: &[u8], current_file: Arc<Mutex<Option<File>>>) {
    if let Ok(msg_str) = std::str::from_utf8(data) {
        if let Ok(ft_msg) = serde_json::from_str::<FileTransferMessage>(msg_str) {
            let mut file_guard = current_file.lock().unwrap();
            match ft_msg {
                FileTransferMessage::Start { filename, .. } => {
                    // Save to system temp dir or local folder for MVP
                    let path = std::env::temp_dir().join(&filename);
                    info!("Receiving file: {:?}", path);
                    match File::create(&path) {
                        Ok(f) => *file_guard = Some(f),
                        Err(e) => error!("Failed to create file: {}", e),
                    }
                }
                FileTransferMessage::Chunk { data } => {
                    if let Some(f) = file_guard.as_mut() {
                        if let Err(e) = f.write_all(&data) {
                            error!("Failed to write chunk: {}", e);
                        }
                    }
                }
                FileTransferMessage::End => {
                    info!("File transfer complete.");
                    *file_guard = None; // Drop file, flushing and closing it
                }
            }
        }
    }
}

fn handle_clipboard_message(data: &[u8]) {
    if let Ok(msg_str) = std::str::from_utf8(data) {
        if let Ok(ClipboardMessage::Text { content }) = serde_json::from_str::<ClipboardMessage>(msg_str) {
            if let Ok(mut clipboard) = Clipboard::new() {
                let _ = clipboard.set_text(content);
            }
        }
    }
}
