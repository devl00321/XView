use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", content = "payload")]
pub enum SignalingMessage {
    /// Host registers itself with the signaling server
    RegisterHost {
        device_id: String,
        /// Host's auth token for this session
        token: String,
        /// Supabase JWT for identity verification
        #[serde(default)]
        jwt: String,
    },
    /// Client requests to connect to a specific host
    RegisterClient {
        device_id: String,
        /// Client's provided password/token to access the host
        token: String,
        /// Supabase JWT for identity verification
        #[serde(default)]
        jwt: String,
    },
    /// Server acknowledges successful registration
    RegistrationSuccess,
    /// Server rejects registration
    RegistrationError(String),

    // WebRTC Signaling Exchange (relayed between Host and Client)
    
    /// SDP Offer (usually from Client to Host, or vice versa depending on who initiates)
    SdpOffer(String),
    /// SDP Answer
    SdpAnswer(String),
    /// ICE Candidate (JSON serialized candidate string)
    IceCandidate(String),
    
    /// Notification that the peer disconnected
    PeerDisconnected,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum ControlMessage {
    MouseMove { x: i32, y: i32 },
    MouseDown { button: MouseButton },
    MouseUp { button: MouseButton },
    MouseScroll { dx: i32, dy: i32 },
    KeyPress { key: String },
    KeyRelease { key: String },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum FileTransferMessage {
    Start { filename: String, size: u64 },
    Chunk { data: Vec<u8> },
    End,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum ClipboardMessage {
    Text { content: String },
}
