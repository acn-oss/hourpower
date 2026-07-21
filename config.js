// ============================================================
// Paste your Firebase project config below.
//
// Firebase Console → Project settings → General →
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
// That's it. No admin email list here any more.
//
// Roles are now managed in two places — both server-side,
// not visible to anyone browsing the site source:
//
//  1. Each user's "role" field in Firestore (users collection).
//     New accounts created via Firebase Console get role "user"
//     by default. To make someone an editor, find their document
//     in Firestore Console → users → [their uid] and change
//     role from "user" to "editor".
//
//  2. The editor email list in firestore.rules, which Firebase
//     enforces on the server. Keep that up to date too.
// ============================================================
