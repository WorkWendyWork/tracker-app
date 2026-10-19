# 👾 Bug Tracker Pro

A single-file issue tracker for game development: list and Kanban views, milestones, story points, tags, notes, bulk actions, JSON import/export, and live sync via Firebase Firestore.

## Run locally
Open `index.html` in a browser, or serve the folder:

```bash
python -m http.server 8000
```

## Deploy on GitHub Pages
1. Push this repo to GitHub.
2. **Settings → Pages →** Source: `main` branch, `/ (root)`.
3. Open the published URL and share it with your team.

## Firebase setup
1. Create a Firebase project, add a Web app, and paste its config into `firebaseConfig` in `index.html`.
2. **Authentication → Sign-in method:** enable **Google**. (Disable *Anonymous* if it was on.)
3. **Authentication → Settings → Authorized domains:** add `<you>.github.io`.
4. Create a Firestore database. Edit `firestore.rules`, replace `your-email@example.com` with your teammates' Google emails, and publish the rules in **Firestore → Rules**.
5. In Google Cloud Console → Credentials, restrict the browser API key to your GitHub Pages domain (HTTP referrers).

> Firebase web config keys are not secrets; access is controlled by the Firestore rules. Only emails on the allow-list can read or edit the tracker. Anyone else who signs in sees "No access".

Without signing in, the tracker works locally in the browser (nothing is saved). Use **Export** to keep a backup.

## AI categorize (optional)
The ✨ button calls Google Gemini using a key you enter in the browser; it is stored only in that browser's `localStorage` and is never committed.
