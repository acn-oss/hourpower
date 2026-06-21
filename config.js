// ============================================================
// STEP 1 — Paste your Firebase project config below.
//
// Firebase Console → ⚙️ Project settings → General →
// "Your apps" → SDK setup and configuration → select "Config"
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyCn-8JMo3dFxsr9V2N9MXdDHB4S4d-0jLw",
  authDomain: "urbanpowerhour.firebaseapp.com",
  projectId: "urbanpowerhour",
  storageBucket: "urbanpowerhour.firebasestorage.app",
  messagingSenderId: "406775941797",
  appId: "1:406775941797:web:7cb0fd241af90a19fcdb4c",
  measurementId: "G-7MFQRY72QZ"
};

// ============================================================
// STEP 2 — List the email address(es) that should be editors
// (able to create projects and see everyone's hours).
//
// Anyone who signs up with an email NOT in this list becomes a
// regular user automatically — they only see their own hours.
//
// IMPORTANT: this list only controls what the app SHOWS you.
// The actual access control is enforced in firestore.rules —
// add the same email(s) there too, or these people won't really
// have editor permissions, just an editor-looking screen with
// nothing in it.
// ============================================================
const ADMIN_EMAILS = [
  "info@urbanpower.dk"
];
