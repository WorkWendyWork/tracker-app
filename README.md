# 👾 Bug Tracker Pro

An issue tracker for game development: list and Kanban views, milestones, story points, tags, assignees, notes, change history, screenshots, bulk actions with undo, JSON import/export, and live team sync via Firebase.

## Where your data is saved
- **Signed out:** issues are saved in this browser (`localStorage`). They survive a refresh, but only on this device.
- **Signed in with Google:** issues are saved to the cloud (Firebase Firestore) and sync live between teammates. Each issue is its own document, so edits by different people don't overwrite each other.
- **Offline while signed in:** keep working. New issues show as `NEW` and get their `BUG-####` number once you're back online.
- When you sign in, the app offers to upload anything saved in the browser to the cloud.
- **Safety nets:** deleting shows an **Undo** for 10 seconds; **Export** downloads a JSON backup; an optional daily backup runs on GitHub (see below). Project renames and imports are journaled, so an interrupted one finishes on the next load instead of losing data.

## Project structure
| File | Purpose |
| --- | --- |
| `index.html` | Page markup and Content Security Policy |
| `app.js` | App logic, local and cloud storage |
| `lib.js` | Pure helpers (escaping, filtering, validation, prompts), unit-tested |
| `theme.js` | Applies the saved theme before the page paints |
| `tailwind.css` | Pre-built styles (generated from `src/input.css`, committed so GitHub Pages works without a build) |
| `firestore.rules` / `storage.rules` | Who may read/write, and what valid data looks like |
| `functions/` | Optional server function for AI categorize (keeps the Gemini key private) |
| `scripts/backup.mjs` | Exports the whole database to JSON |
| `tests/` | Unit tests (`npm test`) and emulator rules tests (`npm run test:rules`) |

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
Rules tests need Java 11+ (they start the Firebase emulator):
```bash
npm run test:rules
```
After adding or changing Tailwind classes, rebuild the stylesheet and commit it:
```bash
npm run build:css
```
GitHub Actions runs the unit tests, the rules tests, and checks that `tailwind.css` is up to date on every push.

## Setup

### 1. Firebase
1. Create a Firebase project and add a Web app; paste its config into `firebaseConfig` at the top of `app.js`, and its id into `.firebaserc`.
2. **Authentication → Sign-in method:** enable **Google**. (Disable *Anonymous* if it was on.)
3. **Authentication → Settings → Authorized domains:** add `localhost` and `<you>.github.io`.
4. Create a **Firestore** database.
5. Replace `your-email@example.com` with your team's Google emails in **both** `firestore.rules` and `storage.rules`, then deploy them:
   ```bash
   npx firebase login
   ```
   ```bash
   npm run deploy:rules
   ```
6. In Google Cloud Console → Credentials, restrict the browser API key to your GitHub Pages domain (HTTP referrers).

> Firebase web config keys are not secrets; access is controlled by the rules. Only emails on the allow-list can read or edit the tracker. Anyone else who signs in sees "No access".

### 2. GitHub Pages
1. Push this repo to GitHub.
2. **Settings → Pages →** Source: `main` branch, `/ (root)`.
3. Open the published URL and share it with your team.

### 3. Optional extras
- **Screenshots** (🖼️ button, or paste an image into the description): enable **Storage** in Firebase. New projects need the Blaze (pay-as-you-go) plan for Storage; usage for a small team typically stays in the free allowance.
- **AI categorize without personal keys** (Blaze plan): copy `functions/.env.example` to `functions/.env` with the same emails, then
  ```bash
  npx firebase functions:secrets:set GEMINI_API_KEY
  ```
  ```bash
  npm run deploy:functions
  ```
  Without the function, the ✨ button asks each person for their own Gemini key and stores it only in their browser (ℹ️ Share → *Forget my Gemini key* removes it).
- **Daily backups:** in Google Cloud Console create a service account with the *Cloud Datastore User* role, create a JSON key, and save it as the repository secret `FIREBASE_SERVICE_ACCOUNT`. The *Daily backup* workflow then saves the database as a downloadable artifact every day (kept 90 days). You can also run it manually from the Actions tab.

## Security notes
- All user text is escaped and Markdown is sanitized with DOMPurify.
- A Content Security Policy forbids inline scripts and limits where code and data can come from.
- Third-party scripts are pinned to exact versions with Subresource Integrity hashes.
- Firestore rules validate every field of every issue, not just who is writing.

## Accessibility
All controls are keyboard reachable with visible focus, dialogs trap focus and close with <kbd>Esc</kbd>, buttons have screen-reader labels, and Kanban cards can be moved with each card's status menu instead of dragging.
