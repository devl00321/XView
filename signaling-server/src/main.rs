use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
    routing::get,
    Router,
};
use clap::Parser;
use futures::{sink::SinkExt, stream::StreamExt};
use shared::SignalingMessage;
use std::{
    collections::HashMap,
    sync::Arc,
};
use tokio::sync::{mpsc, RwLock};
use tower_http::{
    cors::CorsLayer,
    services::ServeDir,
    trace::{DefaultMakeSpan, TraceLayer},
};
use tracing::{error, info, warn};

async fn verify_jwt(jwt: &str) -> bool {
    if jwt.is_empty() { return false; }
    let client = reqwest::Client::new();
    let res = client.get("https://ozffaaounexmujllsssp.supabase.co/auth/v1/user")
        .header("Authorization", format!("Bearer {}", jwt))
        .header("apikey", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im96ZmZhYW91bmV4bXVqbGxzc3NwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3NDM3OTAsImV4cCI6MjA5OTMxOTc5MH0.1vMqw5w8LwDJoBdzQpSWF3jq3kGexxeL0Gx9bkjKe2Y")
        .send()
        .await;
        
    match res {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Port to listen on
    #[arg(short, long, default_value_t = 8080)]
    port: u16,
}

// A simple session tracking structure
struct Session {
    host_tx: Option<mpsc::Sender<Message>>,
    client_tx: Option<mpsc::Sender<Message>>,
    // In a real app, we'd store a hashed token here for verification
    host_token: Option<String>,
}

type AppState = Arc<RwLock<HashMap<String, Session>>>;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    let args = Args::parse();

    let state: AppState = Arc::new(RwLock::new(HashMap::new()));

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(|| async { "OK" }))
        .fallback_service(ServeDir::new("../client-app/dist"))
        .with_state(state)
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::default().include_headers(true)),
        )
        .layer(CorsLayer::permissive());

    let addr = format!("0.0.0.0:{}", args.port);
    info!("Signaling server listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Message>(100);

    // Spawn a task to forward messages from the channel to the websocket
    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut device_id: Option<String> = None;
    let mut is_host = false;

    // Handle incoming messages
    let mut recv_task = tokio::spawn({
        let state = state.clone();
        let tx = tx.clone();
        async move {
            while let Some(Ok(Message::Text(text))) = receiver.next().await {
                if let Ok(msg) = serde_json::from_str::<SignalingMessage>(&text) {
                    match msg {
                        SignalingMessage::RegisterHost { device_id: id, token, jwt } => {
                            if !verify_jwt(&jwt).await {
                                warn!("Host failed JWT verification: {}", id);
                                let _ = tx.send(Message::Text(serde_json::to_string(&SignalingMessage::RegistrationError("Invalid JWT token".to_string())).unwrap().into())).await;
                                continue;
                            }
                            device_id = Some(id.clone());
                            is_host = true;
                            
                            let mut sessions = state.write().await;
                            let session = sessions.entry(id.clone()).or_insert_with(|| Session {
                                host_tx: None,
                                client_tx: None,
                                host_token: None,
                            });
                            
                            session.host_tx = Some(tx.clone());
                            session.host_token = Some(token);
                            info!("Host registered: {}", id);
                            
                            let _ = tx.send(Message::Text(serde_json::to_string(&SignalingMessage::RegistrationSuccess).unwrap().into())).await;
                        }
                        SignalingMessage::RegisterClient { device_id: id, token, jwt } => {
                            if !verify_jwt(&jwt).await {
                                warn!("Client failed JWT verification for host: {}", id);
                                let _ = tx.send(Message::Text(serde_json::to_string(&SignalingMessage::RegistrationError("Invalid JWT token".to_string())).unwrap().into())).await;
                                continue;
                            }
                            let mut sessions = state.write().await;
                            if let Some(session) = sessions.get_mut(&id) {
                                // Basic authentication
                                if session.host_token.as_ref() == Some(&token) {
                                    device_id = Some(id.clone());
                                    is_host = false;
                                    session.client_tx = Some(tx.clone());
                                    info!("Client registered to host: {}", id);
                                    let _ = tx.send(Message::Text(serde_json::to_string(&SignalingMessage::RegistrationSuccess).unwrap().into())).await;
                                } else {
                                    warn!("Client failed auth for host: {}", id);
                                    let _ = tx.send(Message::Text(serde_json::to_string(&SignalingMessage::RegistrationError("Invalid token".to_string())).unwrap().into())).await;
                                }
                            } else {
                                warn!("Client tried to connect to unknown host: {}", id);
                                let _ = tx.send(Message::Text(serde_json::to_string(&SignalingMessage::RegistrationError("Host not found".to_string())).unwrap().into())).await;
                            }
                        }
                        // For any WebRTC signaling message, relay it to the other peer
                        relay_msg @ SignalingMessage::SdpOffer(_) |
                        relay_msg @ SignalingMessage::SdpAnswer(_) |
                        relay_msg @ SignalingMessage::IceCandidate(_) => {
                            if let Some(id) = &device_id {
                                let sessions = state.read().await;
                                if let Some(session) = sessions.get(id) {
                                    let target_tx = if is_host { &session.client_tx } else { &session.host_tx };
                                    if let Some(target) = target_tx {
                                        if let Ok(json) = serde_json::to_string(&relay_msg) {
                                            let _ = target.send(Message::Text(json.into())).await;
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            
            // Cleanup on disconnect
            if let Some(id) = device_id {
                let mut sessions = state.write().await;
                if let Some(session) = sessions.get_mut(&id) {
                    let notify_tx = if is_host {
                        info!("Host disconnected: {}", id);
                        session.host_tx = None;
                        session.client_tx.clone()
                    } else {
                        info!("Client disconnected from host: {}", id);
                        session.client_tx = None;
                        session.host_tx.clone()
                    };
                    
                    if let Some(target) = notify_tx {
                        let msg = serde_json::to_string(&SignalingMessage::PeerDisconnected).unwrap();
                        let _ = target.send(Message::Text(msg.into())).await;
                    }
                    
                    // If both are disconnected, remove the session
                    if session.host_tx.is_none() && session.client_tx.is_none() {
                        sessions.remove(&id);
                    }
                }
            }
        }
    });

    // Wait for either task to finish
    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    }
}
