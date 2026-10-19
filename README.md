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
2. Enable **Authentication → Anonymous** sign-in.
3. Create a Firestore database and publish the rules in `firestore.rules`.
4. In Google Cloud Console, restrict the browser API key to your GitHub Pages domain (HTTP referrers).

> Firebase web config keys are not secrets — access is controlled by Firestore rules and key restrictions. With anonymous auth, **anyone who has the URL can read and edit the tracker.**

## AI categorize (optional)
The ✨ button calls Google Gemini using a key you enter in the browser; it is stored only in that browser's `localStorage` and is never committed.
