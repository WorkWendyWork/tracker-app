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
| `functions/` | Optional server function for AI suggestions (keeps the Gemini key private) |
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
- **AI suggestions without personal keys** (Blaze plan): copy `functions/.env.example` to `functions/.env` with the same emails, then
  ```bash
  npx firebase functions:secrets:set GEMINI_API_KEY
  ```
  ```bash
  npm run deploy:functions
  ```
  Without the function, the ✨ button asks each person for their own Gemini key and stores it only in their browser (ℹ️ Share → *Forget my Gemini key* removes it).
- **Daily backups:** in Google Cloud Console create a service account with the *Cloud Datastore User* role, create a JSON key, and save it as the repository secret `FIREBASE_SERVICE_ACCOUNT`. The *Daily backup* workflow then saves the database as a downloadable artifact every day (kept 90 days). You can also run it manually from the Actions tab.

## AI suggestions
Type a description and click **✨ AI Category**. Gemini fills in the subject, priority, story points and tags, plus the milestone if one clearly fits. It picks from your team's own subjects, milestones and existing tags. Tags you already typed are kept, and nothing is saved until you click **Save Issue**.

Subjects are always **one topic** (for example "Audio" or "Save System", never "UI & Navigation"). If no existing subject fits, the AI proposes a new one, marked *(new)* in the form. It's added to the team's list when you save the bug, and then shows up in the filters.

**🤖 Reorganize with AI** (in ⚙️ Settings → Subjects) cleans up an existing backlog. The AI reads every bug in every project, proposes a list of single-topic subjects, and suggests a subject and tags for each bug. You review a preview, untick anything you disagree with, then apply. Each change is recorded in the bug's history.

The app asks Google which Gemini models your key can use and picks the newest "flash" model automatically, so it keeps working when Google retires a model.

## Settings (⚙️)
Edit the team's lists. Changes apply to every project:
- **Subjects:** add, rename, reorder (this is also the *Sort: Subject* order) or delete. Issues using a deleted subject move to the first subject.
- **Milestones:** add planned milestones (they appear in the form and the AI can pick them), rename, or delete (cleared from issues).
- **Tags:** rename to fix typos, merge two tags by giving them the same name, or delete.

## Search & filters
- **Search** matches all words across the description, subject, tags, milestone, assignee and notes. Use `"quotes"` for an exact phrase and `-word` to exclude. Press <kbd>/</kbd> to jump to the search box and <kbd>Esc</kbd> to clear it. Press <kbd>N</kbd> (or the round **+** button) to log a new issue; <kbd>Ctrl</kbd>+<kbd>Enter</kbd> saves it.
- **🎛️ Filters** opens a panel where you can pick several values per group (Status, Priority, Subject, Story points, Milestone, Assignee, Tags). Values in one group are combined with *or*, groups with *and*. Each option shows how many issues it matches.
- **Quick views:** All issues, My open, Urgent, Unassigned, Recently fixed.
- **Hide completed** (next to the quick views) leaves fixed bugs out of the list *and* out of the filter counts, and hides subjects, tags and milestones with nothing left to do. Handy for seeing what still needs work. Picking *Fixed* in the Status filter still shows them.
- **Sort** by priority, subject, bug number or recently updated; **↓/↑** reverses the order.
- Filters are kept in the page address, so you can **bookmark or share a link** to an exact view. They're also remembered in your browser.

## Security notes
- All user text is escaped and Markdown is sanitized with DOMPurify.
- A Content Security Policy forbids inline scripts and limits where code and data can come from.
- Third-party scripts are pinned to exact versions with Subresource Integrity hashes.
- Firestore rules validate every field of every issue, not just who is writing.

## Accessibility
All controls are keyboard reachable with visible focus, dialogs trap focus and close with <kbd>Esc</kbd>, buttons have screen-reader labels, and Kanban cards can be moved with each card's status menu instead of dragging.
