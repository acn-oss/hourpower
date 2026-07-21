// ============================================================
// Paste your Firebase project config below.
//
// Firebase Console → Project settings → General →
// "Your apps" → SDK setup and configuration → select "Config"
// ============================================================
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
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
