# 👾 Bug Tracker Pro

A single-file issue tracker for game development: list and Kanban views, milestones, story points, tags, notes, bulk actions, JSON import/export, and live sync via Firebase Firestore.

## Where your data is saved
- **Signed out:** issues are saved in this browser (`localStorage`). They survive a refresh, but only on this device.
- **Signed in with Google:** issues are saved to the cloud (Firebase Firestore) and sync live between teammates. Each issue is its own document, so edits by different people never overwrite each other. Changes made while offline are cached and sync when you reconnect.
- When you sign in, the app offers to upload anything saved in the browser to the cloud.
- **Export** downloads a JSON backup at any time; **Import** restores one.

## Project structure
| File | Purpose |
| --- | --- |
| `index.html` | Page markup |
| `app.js` | App logic, local and cloud storage |
| `lib.js` | Pure helpers (escaping, filtering, validation), unit-tested |
| `tailwind.css` | Pre-built styles (generated, committed so GitHub Pages works without a build) |
| `firestore.rules` | Database access rules with the team allow-list |
| `tests/` | Unit tests (`npm test`) |

## Run locally
```bash
python -m http.server 8000
```
Then open http://localhost:8000. (Google sign-in does not work from `file://`.)

## Development
```bash
npm install
```
```bash
npm test
```
After adding or changing Tailwind classes, rebuild the stylesheet and commit it:
```bash
npm run build:css
```
GitHub Actions runs the tests and checks that `tailwind.css` is up to date on every push.

## Deploy on GitHub Pages
1. Push this repo to GitHub.
2. **Settings → Pages →** Source: `main` branch, `/ (root)`.
3. Open the published URL and share it with your team.
4. Add `localhost` and `<you>.github.io` under Firebase **Authentication → Settings → Authorized domains**.

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
