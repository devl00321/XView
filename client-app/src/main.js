import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { initAuth } from "./auth.js";
import { supabase } from "./supabase.js";

let peerConnection;
let controlChannel;
let fileTransferChannel;
let clipboardChannel;
let ws;

const connectBtn = document.getElementById("connect-btn");
const serverUrlInput = document.getElementById("server-url");
const deviceIdInput = document.getElementById("device-id");
const authTokenInput = document.getElementById("auth-token");

// Auto-detect server URL for web clients
if (!window.__TAURI__) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const hostname = window.location.hostname;
  serverUrlInput.value = `${proto}//${hostname}:8080/ws`;
}

const authOverlay = document.getElementById("auth-overlay");
const statusDot = document.getElementById("status-indicator");
const statusText = document.getElementById("status-text");
const remoteVideo = document.getElementById("remote-video");
const fileTransferBtn = document.getElementById("file-transfer-btn");
const fileInput = document.getElementById("file-input");
const syncClipboardBtn = document.getElementById("sync-clipboard-btn");
const fullscreenBtn = document.getElementById("fullscreen-btn");
const navSession = document.getElementById("navSession");

const myDeviceIdDiv = document.getElementById("my-device-id");
const myTokenDiv = document.getElementById("my-token");
const debugOverlay = document.getElementById("debug-overlay");

const settingsSaveBtn = document.getElementById("settings-save-btn");
const settingsDeviceId = document.getElementById("settings-device-id");
const settingsPassword = document.getElementById("settings-password");
const settingsDeviceName = document.getElementById("settings-device-name");
const settingsError = document.getElementById("settings-error");
const settingsSuccess = document.getElementById("settings-success");

// Mobile Sidebar Logic
const appContainer = document.getElementById("app");
const mobileMenuBtn = document.getElementById("mobile-menu-btn");
const mobileBackdrop = document.getElementById("mobile-backdrop");

if (mobileMenuBtn && mobileBackdrop) {
  mobileMenuBtn.addEventListener("click", () => {
    appContainer.classList.add("rail-open");
  });
  mobileBackdrop.addEventListener("click", () => {
    appContainer.classList.remove("rail-open");
  });
}

// View Switching Logic
function setView(view) {
  document.querySelectorAll(".rail-item[data-view]").forEach(b => {
    b.classList.toggle("active", b.getAttribute("data-view") === view);
  });
  document.querySelectorAll(".view").forEach(v => {
    v.classList.toggle("active", v.id === "view-" + view);
  });
  
  if (view === "session") {
    setTimeout(() => fitAddon.fit(), 300);
  }
}

document.querySelectorAll(".rail-item[data-view]").forEach(btn => {
  btn.addEventListener("click", () => {
    if (!btn.disabled) setView(btn.getAttribute("data-view"));
  });
});

// Panel Tab Logic
document.querySelectorAll(".panel-tab[data-tab]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".panel-tab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".panel-content").forEach(c => c.classList.remove("active"));
    
    btn.classList.add("active");
    const tabName = btn.getAttribute("data-tab");
    document.querySelector(`.panel-content[data-tab-content="${tabName}"]`).classList.add("active");
    
    if (tabName === "terminal") {
      setTimeout(() => fitAddon.fit(), 100);
    }
  });
});

// Hide Auth overlay on success
window.addEventListener("auth-success", () => {
  authOverlay.classList.add("hidden");
});

let framesReceived = 0;
let chunksReceived = 0;

let currentLocalDbId = localStorage.getItem("xview_local_id");
let hostSessionToken = null;
let allDevices = [];

// Initialize Authentication Flow
initAuth();

// Wait for successful auth before fetching/creating device credentials
window.addEventListener("auth-success", async () => {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;
  hostSessionToken = session.access_token;
  
  await loadOrCreateDevice(session.user.id);
  await fetchAllDevices(session.user.id);
});

async function fetchAllDevices(userId) {
  const { data, error } = await supabase.from('devices').select('*').eq('user_id', userId);
  if (error) {
    console.error("Failed to fetch devices", error);
    return;
  }
  allDevices = data;
  renderDeviceGrid();
}

function renderDeviceGrid() {
  const grid = document.getElementById("deviceGrid");
  const summary = document.getElementById("deviceSummary");
  if (!grid || !summary) return;
  
  grid.innerHTML = "";
  
  const remoteDevices = allDevices.filter(d => d.id !== currentLocalDbId);
  
  remoteDevices.forEach(d => {
    const card = document.createElement("div");
    card.className = "device-card";
    
    // Auto-fill connection function
    const actionsHtml = `<button class="btn btn--primary" data-action="connect" data-id="${d.device_id}" data-token="${d.access_password}" data-name="${d.device_name || 'Remote Device'}">Connect</button>`;

    card.innerHTML = `
      <div class="dc-thumb">
        <div class="dc-window w1"></div><div class="dc-window w2"></div>
      </div>
      <div class="dc-body">
        <div class="dc-top">
          <div class="dc-badge">${d.device_name ? d.device_name.charAt(0).toUpperCase() : 'D'}</div>
          <div><div class="dc-name">${d.device_name || 'Remote Device'}</div><div class="dc-os">${d.device_id}</div></div>
        </div>
        <span class="pill pill--online"><span class="dot dot--online pulse"></span>Ready</span>
        <div class="dc-meta">Connected to relay</div>
        <div class="dc-actions">${actionsHtml}</div>
      </div>
    `;
    grid.appendChild(card);
  });
  
  if (remoteDevices.length === 0) {
    summary.textContent = "No remote devices found on this account.";
  } else {
    summary.textContent = `${remoteDevices.length} remote devices available.`;
  }
  
  document.querySelectorAll('[data-action="connect"]').forEach(btn => {
    btn.addEventListener("click", () => {
      // Auto-fill inputs and connect
      document.getElementById("device-id").value = btn.getAttribute("data-id");
      document.getElementById("auth-token").value = btn.getAttribute("data-token");
      document.getElementById("sesName").innerText = btn.getAttribute("data-name");
      document.getElementById("connect-btn").click();
    });
  });
}

async function loadOrCreateDevice(userId) {
  myDeviceIdDiv.innerText = "Loading...";
  myTokenDiv.innerText = "Loading...";

  if (currentLocalDbId) {
    const { data, error } = await supabase.from('devices').select('*').eq('id', currentLocalDbId).single();
    if (data) {
      updateUiWithDevice(data);
      return;
    }
    // If not found in DB (maybe deleted), fall through to create new
  }

  // Generate new device
  const newDeviceId = Math.random().toString(36).substring(2, 8).toUpperCase() + Math.random().toString(36).substring(2, 8).toUpperCase();
  const newPassword = Math.random().toString(36).substring(2, 10);
  
  const { data, error } = await supabase.from('devices').insert({
    user_id: userId,
    device_id: newDeviceId.substring(0, 12),
    access_password: newPassword,
    device_name: "My Device"
  }).select().single();

  if (error) {
    console.error("Failed to create device", error);
    myDeviceIdDiv.innerText = "Error";
    return;
  }

  currentLocalDbId = data.id;
  localStorage.setItem("xview_local_id", data.id);
  updateUiWithDevice(data);
}

function updateUiWithDevice(device) {
  myDeviceIdDiv.innerText = device.device_id;
  myTokenDiv.innerText = device.access_password;
  
  // Populate settings form
  settingsDeviceId.value = device.device_id;
  settingsPassword.value = device.access_password;
  settingsDeviceName.value = device.device_name || "";

  // Tell Tauri backend to start the Host Agent using these credentials
  if (window.__TAURI__) {
    // Pass the host session token so the backend can authenticate with the signaling server
    invoke("start_host_agent_cmd", { 
      deviceId: device.device_id, 
      token: device.access_password,
      jwt: hostSessionToken
    }).catch(console.error);
  }
}

// Settings UI Logic

settingsSaveBtn.addEventListener("click", async () => {
  if (!currentLocalDbId) return;
  
  const newId = settingsDeviceId.value.trim();
  const newPass = settingsPassword.value.trim();
  const newName = settingsDeviceName.value.trim();
  
  settingsError.style.display = "none";
  settingsSuccess.style.display = "none";

  if (newId.length !== 12) {
    settingsError.innerText = "Device ID must be exactly 12 characters.";
    settingsError.style.display = "block";
    return;
  }

  if (newPass.length < 4) {
    settingsError.innerText = "Password must be at least 4 characters.";
    settingsError.style.display = "block";
    return;
  }

  settingsSaveBtn.disabled = true;
  settingsSaveBtn.innerText = "Saving...";

  const { data, error } = await supabase.from('devices').update({
    device_id: newId,
    access_password: newPass,
    device_name: newName
  }).eq('id', currentLocalDbId).select().single();

  settingsSaveBtn.disabled = false;
  settingsSaveBtn.innerText = "Save Changes";

  if (error) {
    settingsError.innerText = "Failed to update: " + error.message;
    settingsError.style.display = "block";
  } else {
    settingsSuccess.innerText = "Settings saved successfully! Host restarted.";
    settingsSuccess.style.display = "block";
    updateUiWithDevice(data);
  }
});

// Initialize Terminal
const term = new Terminal({
  theme: {
    background: '#000000',
    foreground: '#f0f0f0',
  },
  cursorBlink: true,
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-container'));

// Window resize handler for terminal
window.addEventListener('resize', () => {
  fitAddon.fit();
});

function updateStatus(connected, text) {
  if (connected) {
    statusDot.classList.add("dot--online");
    statusText.innerText = text || "Connected";
    connectBtn.disabled = true;
    fileTransferBtn.disabled = false;
    syncClipboardBtn.disabled = false;
    fullscreenBtn.disabled = false;
    navSession.disabled = false;
    remoteVideo.style.display = "block";
    setView("session");
  } else {
    statusDot.classList.remove("dot--online");
    statusText.innerText = text || "Disconnected";
    connectBtn.disabled = false;
    fileTransferBtn.disabled = true;
    syncClipboardBtn.disabled = true;
    fullscreenBtn.disabled = true;
    navSession.disabled = true;
    remoteVideo.style.display = "none";
    setView("dashboard");
  }
}

const disconnectBtn = document.getElementById("disconnectBtn");
if (disconnectBtn) {
  disconnectBtn.addEventListener("click", () => {
    if (ws) ws.close();
    if (peerConnection) peerConnection.close();
    updateStatus(false, "Disconnected");
  });
}

connectBtn.addEventListener("click", () => {
  const url = serverUrlInput.value.trim();
  const deviceId = deviceIdInput.value.trim();
  const token = authTokenInput.value.trim();
  
  if (!url || !deviceId || !token) {
    alert("Please enter Server URL, Device ID, and Auth Token.");
    return;
  }

  connectBtn.disabled = true;
  
  // Pass the user's JWT so the signaling server can verify their identity
  startSignaling(url, deviceId, token, hostSessionToken);
});

function startSignaling(url, deviceId, token, jwt) {
  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log("Connected to signaling server");
    // Register as client, provide JWT for security
    ws.send(JSON.stringify({
      type: "RegisterClient",
      payload: { device_id: deviceId, token: token, jwt: jwt }
    }));
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    
    switch (msg.type) {
      case "RegistrationSuccess":
        console.log("Registration successful, creating WebRTC offer...");
        setupWebRTC();
        break;
      case "RegistrationError":
        alert("Registration failed: " + msg.payload);
        updateStatus(false);
        ws.close();
        break;
      case "SdpAnswer":
        console.log("Received SDP Answer");
        const answer = new RTCSessionDescription({ type: "answer", sdp: msg.payload });
        await peerConnection.setRemoteDescription(answer);
        break;
      case "IceCandidate":
        const candidate = JSON.parse(msg.payload);
        await peerConnection.addIceCandidate(candidate);
        break;
      case "PeerDisconnected":
        console.log("Host disconnected");
        updateStatus(false, "Host Disconnected");
        if (peerConnection) {
          peerConnection.close();
        }
        break;
    }
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    updateStatus(false, "Connection Error");
  };
}

async function setupWebRTC() {
  peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({
        type: "IceCandidate",
        payload: JSON.stringify(event.candidate)
      }));
    }
  };

  peerConnection.onconnectionstatechange = () => {
    console.log("Connection state:", peerConnection.connectionState);
    if (peerConnection.connectionState === "connected") {
      updateStatus(true);
    } else if (peerConnection.connectionState === "disconnected" || peerConnection.connectionState === "failed") {
      updateStatus(false);
    }
  };

  // Create Video DataChannel
  // We use a DataChannel for video in this MVP because WebRTC VideoTracks in Rust (webrtc-rs)
  // require RTP packetization, whereas DataChannel lets us just send JPEG bytes directly.
  const videoChannel = peerConnection.createDataChannel("video");
  videoChannel.binaryType = "arraybuffer";
  
  let imageBuffer = [];
  let expectedSize = 0;

  videoChannel.onmessage = (event) => {
    const data = new Uint8Array(event.data);
    
    // Check if it's the header "IMGSTART" (8 bytes) + length (4 bytes)
    if (data.length === 12 && 
        data[0]===73 && data[1]===77 && data[2]===71 && data[3]===83 && 
        data[4]===84 && data[5]===65 && data[6]===82 && data[7]===84) {
      
      // If we already had expectedSize > 0, it means we dropped chunks from the last frame!
      if (expectedSize > 0) {
        console.warn("Dropped frame! Expected", expectedSize, "but got new header");
      }
      
      // Use >>> 0 to ensure it's treated as an unsigned 32-bit integer
      expectedSize = ((data[8] << 24) | (data[9] << 16) | (data[10] << 8) | data[11]) >>> 0;
      imageBuffer = [];
      chunksReceived = 0;
      return;
    }
    
    if (expectedSize > 0) {
      imageBuffer.push(data);
      chunksReceived++;
      let currentSize = imageBuffer.reduce((acc, val) => acc + val.length, 0);
      
      if (currentSize >= expectedSize) {
        framesReceived++;
        
        // Reassemble and display
        const blob = new Blob(imageBuffer, { type: "image/jpeg" });
        const url = URL.createObjectURL(blob);
        
        // Revoke the old URL to prevent memory leaks
        if (remoteVideo.src) {
            URL.revokeObjectURL(remoteVideo.src);
        }
        
        remoteVideo.src = url;
        
        expectedSize = 0;
        imageBuffer = [];
      }
    }
  };

  // Create Control DataChannel for Mouse/Keyboard
  controlChannel = peerConnection.createDataChannel("control");
  
  // Create Terminal DataChannel
  const terminalChannel = peerConnection.createDataChannel("terminal");
  terminalChannel.onmessage = (event) => {
    term.write(event.data);
  };
  
  term.onData((data) => {
    if (terminalChannel.readyState === "open") {
      terminalChannel.send(data);
    }
  });

  // Create File Transfer DataChannel
  fileTransferChannel = peerConnection.createDataChannel("file_transfer");

  // Create Clipboard DataChannel
  clipboardChannel = peerConnection.createDataChannel("clipboard");

  setupInputCapture();
  setupFileTransfer();
  setupClipboardSync();

  // Create Offer
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  
  ws.send(JSON.stringify({
    type: "SdpOffer",
    payload: offer.sdp
  }));
}

// -------------------------
// Input Capture Logic
// -------------------------

function getMappedCoordinates(clientX, clientY) {
  const rect = remoteVideo.getBoundingClientRect();
  
  // Calculate natural vs displayed aspect ratios to find actual image bounds due to object-fit: contain
  const naturalRatio = remoteVideo.naturalWidth / remoteVideo.naturalHeight;
  const rectRatio = rect.width / rect.height;
  
  let renderWidth, renderHeight, xOffset, yOffset;
  
  if (naturalRatio > rectRatio) {
    // Image is bound by width, black bars on top/bottom
    renderWidth = rect.width;
    renderHeight = rect.width / naturalRatio;
    xOffset = 0;
    yOffset = (rect.height - renderHeight) / 2;
  } else {
    // Image is bound by height, black bars on left/right
    renderHeight = rect.height;
    renderWidth = rect.height * naturalRatio;
    xOffset = (rect.width - renderWidth) / 2;
    yOffset = 0;
  }

  // Adjust client coordinates relative to the rendered image box
  const imgX = clientX - rect.left - xOffset;
  const imgY = clientY - rect.top - yOffset;
  
  // Prevent out of bounds
  if (imgX < 0 || imgY < 0 || imgX > renderWidth || imgY > renderHeight) {
    return null; // Out of bounds
  }

  // Map to the native resolution
  const x = Math.floor((imgX / renderWidth) * remoteVideo.naturalWidth);
  const y = Math.floor((imgY / renderHeight) * remoteVideo.naturalHeight);
  
  return { x, y };
}

function setupInputCapture() {
  const sendMove = (clientX, clientY) => {
    if (!controlChannel || controlChannel.readyState !== "open") return;
    if (!remoteVideo.naturalWidth) return;
    
    const coords = getMappedCoordinates(clientX, clientY);
    if (!coords) return;
    
    controlChannel.send(JSON.stringify({
      type: "MouseMove",
      x: coords.x,
      y: coords.y
    }));
  };

  // Mouse Events
  remoteVideo.addEventListener("mousemove", (e) => {
    sendMove(e.clientX, e.clientY);
  });

  remoteVideo.addEventListener("mousedown", (e) => {
    if (!controlChannel || controlChannel.readyState !== "open") return;
    let btn = "Left";
    if (e.button === 1) btn = "Middle";
    if (e.button === 2) btn = "Right";
    
    controlChannel.send(JSON.stringify({
      type: "MouseDown",
      button: btn
    }));
  });

  window.addEventListener("mouseup", (e) => {
    // Listen on window so if dragging outside video, it still releases
    if (!controlChannel || controlChannel.readyState !== "open") return;
    let btn = "Left";
    if (e.button === 1) btn = "Middle";
    if (e.button === 2) btn = "Right";
    
    controlChannel.send(JSON.stringify({
      type: "MouseUp",
      button: btn
    }));
  });
  
  // Touch Events (Mobile)
  remoteVideo.addEventListener("touchstart", (e) => {
    if (e.touches.length > 0) {
      sendMove(e.touches[0].clientX, e.touches[0].clientY);
      
      // Simulate left click down on tap
      if (controlChannel && controlChannel.readyState === "open") {
        controlChannel.send(JSON.stringify({
          type: "MouseDown",
          button: "Left"
        }));
      }
    }
  }, { passive: true });

  window.addEventListener("touchend", (e) => {
    // Simulate left click up on tap release
    if (controlChannel && controlChannel.readyState === "open") {
      controlChannel.send(JSON.stringify({
        type: "MouseUp",
        button: "Left"
      }));
    }
  });
  
  remoteVideo.addEventListener("touchmove", (e) => {
    if (e.touches.length > 0) {
      // Prevent scrolling while interacting with the screen
      if (e.cancelable) e.preventDefault();
      sendMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: false });

  // Prevent context menu on right click
  remoteVideo.addEventListener("contextmenu", e => e.preventDefault());

  window.addEventListener("keydown", (e) => {
    // Only capture keys if connection is open and we aren't typing in the terminal or inputs
    if (!controlChannel || controlChannel.readyState !== "open") return;
    if (document.activeElement.tagName === "INPUT") return;
    if (document.querySelector('.panel-content[data-tab-content="terminal"]').classList.contains('active')) return;
    
    e.preventDefault(); // Prevent default browser actions (like scrolling with space/arrows, finding text)
    
    controlChannel.send(JSON.stringify({
      type: "KeyPress",
      key: e.key
    }));
  });

  window.addEventListener("keyup", (e) => {
    if (!controlChannel || controlChannel.readyState !== "open") return;
    if (document.activeElement.tagName === "INPUT") return;
    if (document.querySelector('.panel-content[data-tab-content="terminal"]').classList.contains('active')) return;
    
    e.preventDefault();
    
    controlChannel.send(JSON.stringify({
      type: "KeyRelease",
      key: e.key
    }));
  });

  // Full Screen Logic
  const appContainer = document.getElementById("app");
  const fsExitBtn = document.getElementById("fsExitBtn");
  
  fullscreenBtn.addEventListener("click", () => {
    appContainer.classList.add("fs");
    // Optionally trigger browser fullscreen
    if (!document.fullscreenElement) {
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen();
      } else if (document.documentElement.webkitRequestFullscreen) {
        document.documentElement.webkitRequestFullscreen();
      }
    }
  });

  if (fsExitBtn) {
    fsExitBtn.addEventListener("click", () => {
      appContainer.classList.remove("fs");
      if (document.fullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      }
    });
  }

  // Handle exiting fullscreen via Esc key or system gestures
  const handleFsChange = () => {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      appContainer.classList.remove("fs");
    }
  };
  document.addEventListener("fullscreenchange", handleFsChange);
  document.addEventListener("webkitfullscreenchange", handleFsChange);
}

// -------------------------
// File Transfer Logic
// -------------------------
function setupFileTransfer() {
  fileTransferBtn.addEventListener("click", () => {
    fileInput.click();
  });

  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!fileTransferChannel || fileTransferChannel.readyState !== "open") {
      alert("File transfer channel is not open.");
      return;
    }

    fileTransferBtn.disabled = true;
    fileTransferBtn.innerText = "Sending...";

    // Send Start message
    fileTransferChannel.send(JSON.stringify({
      type: "Start",
      filename: file.name,
      size: file.size
    }));

    const CHUNK_SIZE = 16384; // 16KB chunks
    let offset = 0;

    const reader = new FileReader();
    
    reader.onload = async (e) => {
      const buffer = e.target.result;
      const array = Array.from(new Uint8Array(buffer));
      
      // Wait for buffer space if needed
      while (fileTransferChannel.bufferedAmount > 1024 * 1024) {
        await new Promise(r => setTimeout(r, 10));
      }

      fileTransferChannel.send(JSON.stringify({
        type: "Chunk",
        data: array
      }));

      offset += CHUNK_SIZE;
      if (offset < file.size) {
        readSlice(offset);
      } else {
        fileTransferChannel.send(JSON.stringify({ type: "End" }));
        fileTransferBtn.innerText = "Send File";
        fileTransferBtn.disabled = false;
        fileInput.value = "";
      }
    };

    const readSlice = (o) => {
      const slice = file.slice(o, o + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    readSlice(0);
  });
}

// -------------------------
// Clipboard Sync Logic
// -------------------------
function setupClipboardSync() {
  syncClipboardBtn.addEventListener("click", async () => {
    if (!clipboardChannel || clipboardChannel.readyState !== "open") {
      alert("Clipboard channel is not open.");
      return;
    }
    
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        clipboardChannel.send(JSON.stringify({
          type: "Text",
          content: text
        }));
        syncClipboardBtn.innerText = "Synced!";
        setTimeout(() => syncClipboardBtn.innerText = "Sync Clipboard", 2000);
      }
    } catch (err) {
      console.error("Failed to read clipboard: ", err);
      alert("Failed to read clipboard. Ensure you have granted permissions.");
    }
  });
}
