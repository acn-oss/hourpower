# Hour Power

A small hour-registration app: people log in, log hours against projects,
and you (the editor) see everyone's entries in one place. No build tools,
no server to maintain — it's plain HTML/CSS/JS hosted on GitHub Pages,
backed by a free Firebase project for accounts and data.

Total setup time: about 10–15 minutes, once.

---

## 1. Create a free Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and sign in with a Google account.
2. Click **Add project**, give it a name (e.g. `hour-power`), and finish the wizard (you can skip Google Analytics).
3. In the left sidebar, go to **Security → Authentication → Get started**.
   - Under **Sign-in method**, enable **Email/Password**.
4. In the left sidebar, go to **Databases & Storage → Firestore → Create database**.
   - Choose any nearby location.
   - Start in **production mode** (we'll paste in proper rules in step 3).

   *(Firebase periodically reshuffles these menu labels — if yours look different, search "Authentication" or "Firestore" in the console's search bar at the top and it'll jump you straight there.)*

## 2. Get your config and connect the app

1. In Firebase, click the gear icon → **Project settings**.
2. Scroll to **Your apps** → click the **</>** (web) icon → register an app (any nickname, no need for hosting).
3. You'll see a `firebaseConfig` object. Copy it.
4. Open **`config.js`** in this project and paste your values in, replacing the placeholders.
5. In the same file, set `ADMIN_EMAILS` to your own email (and any other editors). This is the email you'll sign up with.

## 3. Lock down the data with security rules

This is what actually decides who can see and edit what — without it, anyone could read everyone's data.

1. In Firebase, go to **Databases & Storage → Firestore → Rules**.
2. Open **`firestore.rules`** in this project, copy its contents.
3. Paste it into the Firebase rules editor, **replacing `you@example.com` with the same email(s) you put in `ADMIN_EMAILS`**.
4. Click **Publish**.

> Both files need the same admin email(s) — `config.js` controls what the app *shows* you, `firestore.rules` is what's actually *enforced*.

## 4. Try it locally (optional but recommended)

Opening `index.html` directly by double-clicking can run into browser restrictions, so serve it locally instead. With Python installed:

```bash
cd hour-tracker
python3 -m http.server 8000
```

Then visit `http://localhost:8000`. Sign up with your admin email first — you should land on the editor screen. Create a project, then sign up a second account with any other email to confirm it lands on the regular user screen.

## 5. Publish on GitHub Pages

1. Create a new repository on GitHub (public or private both work).
2. Push all the files in this folder to it:
   ```bash
   cd hour-tracker
   git init
   git add .
   git commit -m "Hour Power"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
   git push -u origin main
   ```
3. On GitHub, go to the repo's **Settings → Pages**.
4. Under **Build and deployment**, set **Source** to **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
5. After a minute, your site will be live at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

That's it — share that link with your team.

---

## Adding or removing editors later

Edit `ADMIN_EMAILS` in `config.js` **and** the matching list in Firestore's Rules tab in the Firebase console, then push/publish again. Existing accounts pick up the new role the next time they log in.

## Notes & limits

- Firebase's free **Spark plan** comfortably covers a small team's worth of hour entries — there's no cost unless you outgrow it by a wide margin.
- Anyone with your site link can currently sign up as a regular user (they just won't get editor access unless their email is on your admin list). If you'd rather invite people manually instead of open signup, the easiest option is to create their accounts yourself in Firebase Console → Security → Authentication → Add user, and just tell people their password.
- All data lives in Firebase, not in the GitHub repo — your repo only holds the code.
