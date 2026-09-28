import { supabase } from './supabase.js';

const authOverlay = document.getElementById("auth-overlay");

const authTitle = document.getElementById("auth-title");
const authError = document.getElementById("auth-error");
const authEmail = document.getElementById("auth-email");
const authPassword = document.getElementById("auth-password");
const authSubmitBtn = document.getElementById("auth-submit-btn");
const authToggleMode = document.getElementById("auth-toggle-mode");
const authForm = document.getElementById("auth-form");

const mfaForm = document.getElementById("mfa-form");
const mfaCode = document.getElementById("mfa-code");
const mfaSubmitBtn = document.getElementById("mfa-submit-btn");
const mfaQrContainer = document.getElementById("mfa-qr-container");
const mfaQr = document.getElementById("mfa-qr");
const mfaSecret = document.getElementById("mfa-secret");

const logoutBtn = document.getElementById("logout-btn");

let isLoginMode = true;
let factorId = null;

export async function initAuth() {
  authToggleMode.addEventListener("click", () => {
    isLoginMode = !isLoginMode;
    authTitle.innerText = isLoginMode ? "Login" : "Register";
    authSubmitBtn.innerText = isLoginMode ? "Login" : "Register";
    authToggleMode.innerText = isLoginMode ? "Don't have an account? Register" : "Already have an account? Login";
    authError.style.display = "none";
  });

  authSubmitBtn.addEventListener("click", handleAuthSubmit);
  mfaSubmitBtn.addEventListener("click", handleMfaSubmit);
  logoutBtn.addEventListener("click", handleLogout);

  // Check initial session
  const { data: { session } } = await supabase.auth.getSession();
  await handleSession(session);

  // Listen for auth changes
  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
      await handleSession(session);
    }
  });
}

async function handleSession(session) {
  if (!session) {
    showAuth();
    return;
  }

  // Check MFA status
  const { data: { currentLevel } } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();

  if (currentLevel === 'aal1' || currentLevel === 'aal2') {
    // For development/testing, we'll allow AAL1 (no MFA) to proceed directly to the app
    showMain();
  }
}

async function handleAuthSubmit() {
  const email = authEmail.value.trim();
  const password = authPassword.value;
  authError.style.display = "none";
  authSubmitBtn.disabled = true;
  authSubmitBtn.innerText = "Loading...";

  try {
    let error;
    let data;
    if (isLoginMode) {
      const res = await supabase.auth.signInWithPassword({ email, password });
      error = res.error;
      data = res.data;
    } else {
      const res = await supabase.auth.signUp({ email, password });
      error = res.error;
      data = res.data;
    }

    if (error) throw error;
    
    // If registration was successful but user is not signed in (email confirmation required)
    if (!isLoginMode && data?.user && !data.session) {
      authError.style.color = "var(--sage)"; // Make it green for success
      authError.style.backgroundColor = "var(--sage-tint)";
      authError.innerText = "Registration successful! Please check your email to verify your account.";
      authError.style.display = "block";
    }
  } catch (err) {
    authError.style.color = ""; // Reset to default error color
    authError.style.backgroundColor = "";
    authError.innerText = err.message;
    authError.style.display = "block";
  } finally {
    authSubmitBtn.disabled = false;
    authSubmitBtn.innerText = isLoginMode ? "Login" : "Register";
  }
}

async function setupMfa() {
  try {
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp'
    });
    if (error) throw error;

    factorId = data.id;

    // Convert SVG to base64 for display
    const svgBase64 = btoa(data.totp.qr_code);
    mfaQr.src = `data:image/svg+xml;base64,${svgBase64}`;
    mfaSecret.innerText = `Secret: ${data.totp.secret}`;

    authForm.style.display = "none";
    mfaForm.style.display = "block";
    mfaQrContainer.style.display = "block";
    authTitle.innerText = "Setup 2FA";
  } catch (err) {
    console.error("MFA Setup Error", err);
    authError.innerText = "Failed to setup 2FA";
    authError.style.display = "block";
  }
}

function showMfaVerify() {
  authForm.style.display = "none";
  mfaForm.style.display = "block";
  mfaQrContainer.style.display = "none";
  authTitle.innerText = "Verify 2FA";
}

async function handleMfaSubmit() {
  const code = mfaCode.value.trim();
  if (!code || code.length !== 6) return;

  mfaSubmitBtn.disabled = true;
  mfaSubmitBtn.innerText = "Verifying...";

  try {
    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
    if (challengeError) throw challengeError;

    const { data, error } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challengeData.id,
      code
    });

    if (error) throw error;

    // Successfully verified MFA, handleSession will be triggered by onAuthStateChange or we can call it
    const { data: { session } } = await supabase.auth.getSession();
    await handleSession(session);

  } catch (err) {
    alert("Invalid 2FA code");
  } finally {
    mfaSubmitBtn.disabled = false;
    mfaSubmitBtn.innerText = "Verify";
  }
}

async function handleLogout() {
  await supabase.auth.signOut();
}

function showAuth() {
  authOverlay.classList.remove("hidden");
  logoutBtn.style.display = "none";

  authForm.style.display = "block";
  mfaForm.style.display = "none";
}

function showMain() {
  authOverlay.classList.add("hidden");
  logoutBtn.style.display = "inline-block";

  // Custom event to tell main.js to load devices
  window.dispatchEvent(new Event("auth-success"));
}
