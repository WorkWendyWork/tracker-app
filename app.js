// ==========================================
// 🔴 FIREBASE CONFIGURATION 🔴
// These values are public by design; access is controlled by firestore.rules.
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyBleyHfc4dKFvAMMjFSSj8K06yg4x7FlZI",
  authDomain: "tracker-pro-20352.firebaseapp.com",
  projectId: "tracker-pro-20352",
  storageBucket: "tracker-pro-20352.firebasestorage.app",
  messagingSenderId: "420152257572",
  appId: "1:420152257572:web:aca522d09080ecc392fcb1"
};
const WORKSPACE = 'default_workspace';
// ==========================================

// --- App State ---
let issues = [];
let projects = ['main'];
let currentProject = 'main';
let members = [];             // [{ email, name }] — teammates who have signed in
let settings = { ...DEFAULT_SETTINGS };
let isKanban = false;
let selectedIssues = new Set();
let db = null;
let auth = null;
let projectModalMode = '';    // 'add' | 'edit'
let noteTarget = null;        // { issueId, noteId? }
let unsubs = [];              // cloud listeners for the current session
let unsubIssues = null;
let numbering = false;

const $ = (id) => document.getElementById(id);

function setSyncStatus(text, tone) {
    const tones = {
        ok: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200',
        warn: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-200',
        bad: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200'
    };
    const el = $('syncStatus');
    el.innerText = text;
    el.className = `text-xs px-2 py-1 rounded font-medium ${tones[tone]}`;
}

const isOnline = () => !!(db && auth && auth.currentUser);
const me = () => (auth && auth.currentUser) || null;
const who = () => (me() && (me().displayName || me().email)) || 'Me';
const myEmail = () => (me() && me().email ? me().email.toLowerCase() : '');
const memberName = (email) => (members.find(m => m.email === email) || {}).name || email;

function handleCloudError(e, label) {
    console.error(label, e);
    if (e && e.code === 'permission-denied') {
        setSyncStatus('⛔ No access', 'bad');
        toast("You don't have access. Ask the owner to add your email to the allow-list.");
    } else if (e && e.code === 'failed-precondition' && /offline/i.test(e.message || '')) {
        toast('That action needs an internet connection. Try again when you are back online.');
    } else {
        setSyncStatus('⚠️ Sync error', 'bad');
        toast('Could not save to the cloud: ' + (e && e.message ? e.message : e));
    }
}

// ==========================================
// Toast with optional action (used for Undo)
// ==========================================
let toastTimer = null;
let toastCallback = null;

function toast(text, actionLabel, onAction, ms = 6000) {
    clearTimeout(toastTimer);
    $('toastText').innerText = text;
    toastCallback = onAction || null;
    $('toastAction').innerText = actionLabel || '';
    $('toastAction').classList.toggle('hidden', !onAction);
    $('toast').classList.remove('hidden');
    $('toast').classList.add('flex');
    toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
    $('toast').classList.add('hidden');
    $('toast').classList.remove('flex');
    toastCallback = null;
}

// ==========================================
// Local storage (used while signed out, kept in this browser)
// ==========================================
const LOCAL_KEY = 'btp_local_v1';
const SETTINGS_KEY = 'btp_settings';

function readLocal() {
    try {
        const d = JSON.parse(localStorage.getItem(LOCAL_KEY));
        if (d && Array.isArray(d.projects) && d.issues && typeof d.issues === 'object') return d;
    } catch (e) { /* storage blocked or corrupt */ }
    return { projects: ['main'], issues: {} };
}
let local = readLocal();

function writeLocal() {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(local)); }
    catch (e) { toast('Could not save in this browser (storage full or blocked). Use Export to keep a backup.'); }
}

const localStore = {
    load() {
        projects = local.projects.length ? [...local.projects] : ['main'];
        if (!projects.includes(currentProject)) currentProject = projects[0];
        issues = (local.issues[currentProject] || []).map(sanitizeIssue);
        members = [];
        try { settings = sanitizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY))); } catch (e) { settings = { ...DEFAULT_SETTINGS }; }
        updateProjectDropdown();
        updateAssigneeOptions();
        renderIssues();
    },
    _commit() {
        local.issues[currentProject] = issues;
        writeLocal();
        renderIssues();
    },
    create(issue) {
        issues.push({ ...issue, tag: fmtBug(nextBugNumber(issues)) });
        this._commit();
    },
    update(id, fields) {
        const it = issues.find(i => i.id === id);
        if (!it) return;
        const history = withHistory(it.history, who(), describeChanges(it, fields));
        Object.assign(it, fields, { history, updatedBy: who(), updatedAt: Date.now() });
        this._commit();
    },
    setNotes(id, fn, historyText) {
        const it = issues.find(i => i.id === id);
        if (!it) return;
        it.notes = fn(it.notes);
        it.history = withHistory(it.history, who(), historyText);
        this._commit();
    },
    addNote(id, note) { this.setNotes(id, notes => [...notes, note], 'note added'); },
    setStatus(ids, status) {
        ids.forEach(id => this.update(id, { status }));
    },
    remove(ids) {
        const removed = issues.filter(i => ids.has(i.id));
        issues = issues.filter(i => !ids.has(i.id));
        this._commit();
        return removed;
    },
    restore(arr) {
        const ids = new Set(issues.map(i => i.id));
        issues.push(...arr.filter(i => !ids.has(i.id)));
        this._commit();
    },
    replaceAll(arr) {
        issues = arr;
        this._commit();
    },
    addProject(name) {
        if (!local.projects.includes(name)) local.projects.push(name);
        currentProject = name;
        writeLocal();
        this.load();
    },
    renameProject(oldName, newName) {
        local.projects = local.projects.map(p => p === oldName ? newName : p);
        local.issues[newName] = local.issues[oldName] || [];
        delete local.issues[oldName];
        currentProject = newName;
        writeLocal();
        this.load();
    },
    saveSettings(s) {
        settings = s;
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
    }
};

// ==========================================
// Cloud storage (Firestore, one document per issue)
//   workspaces/{ws}/meta/projects            { list: [...] }
//   workspaces/{ws}/meta/members             { list: [{ email, name }] }
//   workspaces/{ws}/meta/settings            { engine, genre, language }
//   workspaces/{ws}/ops/{opId}               journal for multi-step jobs
//   workspaces/{ws}/projects/{p}             { nextBug }
//   workspaces/{ws}/projects/{p}/issues/{id} { ...issue }
// ==========================================
const wsRef = () => db.collection('workspaces').doc(WORKSPACE);
const metaRef = (name) => wsRef().collection('meta').doc(name);
const opsCol = () => wsRef().collection('ops');
const projectRef = (p) => wsRef().collection('projects').doc(p);
const issuesCol = (p) => projectRef(p).collection('issues');

// Firestore allows 500 writes per batch.
async function commitInBatches(ops) {
    for (const part of chunk(ops, 450)) {
        const batch = db.batch();
        part.forEach(op => op(batch));
        await batch.commit();
    }
}

// New issues are saved immediately without a number (this works offline),
// then numbered in a transaction once the device is online.
async function numberPending(project) {
    if (numbering || !isOnline()) return;
    numbering = true;
    try {
        const snap = await issuesCol(project).where('createdByUid', '==', me().uid).where('tag', '==', '').get();
        const docs = snap.docs.sort((a, b) => (a.data().createdAt || 0) - (b.data().createdAt || 0));
        for (const d of docs) {
            await db.runTransaction(async tx => {
                const p = await tx.get(projectRef(project));
                const fresh = await tx.get(d.ref);
                if (!fresh.exists || fresh.data().tag) return;
                const next = (p.exists && p.data().nextBug) || 1;
                tx.set(projectRef(project), { nextBug: next + 1 }, { merge: true });
                tx.update(d.ref, { tag: fmtBug(next) });
            });
        }
    } catch (e) {
        if (e.code !== 'unavailable') console.warn('Numbering will retry later:', e);
    } finally {
        numbering = false;
    }
}

const cloudStore = {
    load() {
        subscribeMeta();
        resumeOps().finally(subscribeIssues);
    },
    create(issue) {
        const project = currentProject;
        issuesCol(project).doc(issue.id).set({ ...issue, tag: '', createdByUid: me().uid })
            .then(() => numberPending(project))
            .catch(e => handleCloudError(e, 'Create error:'));
    },
    update(id, fields) {
        const it = issues.find(i => i.id === id);
        if (!it) return;
        const history = withHistory(it.history, who(), describeChanges(it, fields));
        issuesCol(currentProject).doc(id).update({ ...fields, history, updatedBy: who(), updatedAt: Date.now() })
            .catch(e => handleCloudError(e, 'Update error:'));
    },
    addNote(id, note) {
        const it = issues.find(i => i.id === id);
        issuesCol(currentProject).doc(id).update({
            notes: firebase.firestore.FieldValue.arrayUnion(note),
            history: withHistory(it && it.history, who(), 'note added'),
            updatedBy: who(), updatedAt: Date.now()
        }).catch(e => handleCloudError(e, 'Note error:'));
    },
    // Editing or deleting a note rewrites the list, so do it on the latest copy.
    async setNotes(id, fn, historyText) {
        const ref = issuesCol(currentProject).doc(id);
        try {
            await db.runTransaction(async tx => {
                const snap = await tx.get(ref);
                if (!snap.exists) return;
                const cur = sanitizeIssue({ ...snap.data(), id });
                tx.update(ref, { notes: fn(cur.notes), history: withHistory(cur.history, who(), historyText), updatedBy: who(), updatedAt: Date.now() });
            });
        } catch (e) { handleCloudError(e, 'Note error:'); }
    },
    setStatus(ids, status) {
        const col = issuesCol(currentProject);
        commitInBatches([...ids].map(id => {
            const it = issues.find(i => i.id === id) || {};
            const history = withHistory(it.history, who(), describeChanges(it, { status }));
            return b => b.update(col.doc(id), { status, history, updatedBy: who(), updatedAt: Date.now() });
        })).catch(e => handleCloudError(e, 'Bulk update error:'));
    },
    remove(ids) {
        const col = issuesCol(currentProject);
        const removed = issues.filter(i => ids.has(i.id));
        commitInBatches([...ids].map(id => b => b.delete(col.doc(id))))
            .catch(e => handleCloudError(e, 'Delete error:'));
        return removed;
    },
    restore(arr) {
        const col = issuesCol(currentProject);
        commitInBatches(arr.map(i => b => b.set(col.doc(i.id), i)))
            .catch(e => handleCloudError(e, 'Restore error:'));
    },
    // Journaled: write everything first, then remove what the backup doesn't have.
    // If interrupted while writing, nothing is deleted (you get old + new).
    async replaceAll(arr) {
        const project = currentProject;
        const col = issuesCol(project);
        const journal = arr.length <= 20000;
        const opRef = opsCol().doc();
        try {
            setSyncStatus('⏳ Importing...', 'warn');
            if (journal) await opRef.set({ type: 'import', project, keep: arr.map(i => i.id), phase: 'writing', by: who(), at: Date.now() });
            await commitInBatches([
                ...arr.map(i => b => b.set(col.doc(i.id), i)),
                b => b.set(projectRef(project), { nextBug: nextBugNumber(arr) }, { merge: true })
            ]);
            if (journal) await opRef.update({ phase: 'written' });
            await finishImport(project, new Set(arr.map(i => i.id)));
            if (journal) await opRef.delete();
        } catch (e) { handleCloudError(e, 'Import error:'); }
    },
    async addProject(name) {
        try {
            await db.runTransaction(async tx => {
                const snap = await tx.get(metaRef('projects'));
                const list = (snap.exists && snap.data().list) || ['main'];
                if (!list.includes(name)) list.push(name);
                tx.set(metaRef('projects'), { list });
            });
            currentProject = name;
            subscribeIssues();
        } catch (e) { handleCloudError(e, 'Project error:'); }
    },
    // Journaled so an interrupted rename is finished on the next load.
    async renameProject(oldName, newName) {
        const opRef = opsCol().doc();
        try {
            setSyncStatus('⏳ Renaming...', 'warn');
            await opRef.set({ type: 'rename', from: oldName, to: newName, by: who(), at: Date.now() });
            await runRename(oldName, newName);
            await opRef.delete();
            currentProject = newName;
            subscribeIssues();
        } catch (e) { handleCloudError(e, 'Rename error:'); }
    },
    async saveSettings(s) {
        settings = s;
        try { await metaRef('settings').set(s); } catch (e) { handleCloudError(e, 'Settings error:'); }
    }
};

const store = () => isOnline() ? cloudStore : localStore;

async function finishImport(project, keep) {
    const existing = await issuesCol(project).get();
    await commitInBatches(existing.docs.filter(d => !keep.has(d.id)).map(d => b => b.delete(d.ref)));
}

// Every step is safe to repeat: copy (overwrite), switch list, delete old.
async function runRename(oldName, newName) {
    const [docs, meta, target] = await Promise.all([issuesCol(oldName).get(), projectRef(oldName).get(), projectRef(newName).get()]);
    const nextBug = Math.max((meta.exists && meta.data().nextBug) || 1, (target.exists && target.data().nextBug) || 1);
    await commitInBatches([
        ...docs.docs.map(d => b => b.set(issuesCol(newName).doc(d.id), d.data())),
        b => b.set(projectRef(newName), { nextBug }, { merge: true })
    ]);
    await db.runTransaction(async tx => {
        const snap = await tx.get(metaRef('projects'));
        let list = ((snap.exists && snap.data().list) || ['main']).map(p => p === oldName ? newName : p);
        list = [...new Set(list)];
        if (!list.includes(newName)) list.push(newName);
        tx.set(metaRef('projects'), { list });
    });
    await commitInBatches([
        ...docs.docs.map(d => b => b.delete(d.ref)),
        b => b.delete(projectRef(oldName))
    ]);
}

// Finish multi-step jobs that were interrupted (closed tab, lost connection).
async function resumeOps() {
    try {
        const ops = await opsCol().get();
        for (const op of ops.docs) {
            const o = op.data();
            if (o.type === 'rename') {
                setSyncStatus('⏳ Finishing rename...', 'warn');
                await runRename(o.from, o.to);
                if (currentProject === o.from) currentProject = o.to;
            } else if (o.type === 'import') {
                if (o.phase === 'written') await finishImport(o.project, new Set(o.keep || []));
                else toast(`An import into "${o.project}" was interrupted. Nothing was deleted; import the file again to finish.`);
            }
            await op.ref.delete();
        }
    } catch (e) {
        if (e.code !== 'unavailable') console.warn('Could not resume pending jobs:', e);
    }
}

// Older versions kept a whole project in one document (data/{project}).
// Move that into per-issue documents once, the first time it is opened.
async function migrateLegacy(project) {
    const legacyRef = wsRef().collection('data').doc(project);
    const counterRef = wsRef().collection('counters').doc(project);
    const snap = await legacyRef.get();
    if (!snap.exists) return;
    const old = validateImport(snap.data().issues || []) || [];
    let next = nextBugNumber(old);
    old.forEach(i => { if (!i.tag) i.tag = fmtBug(next++); });
    await commitInBatches([
        ...old.map(i => b => b.set(issuesCol(project).doc(i.id), i)),
        b => b.set(projectRef(project), { nextBug: next }, { merge: true }),
        b => b.delete(legacyRef),
        b => b.delete(counterRef)
    ]);
    console.info(`Migrated ${old.length} issues in "${project}" to per-issue documents.`);
}

// --- Live Sync (every teammate sees changes instantly) ---
async function subscribeIssues() {
    if (unsubIssues) unsubIssues();
    unsubIssues = null;
    if (!isOnline()) return;
    const project = currentProject;
    try { await migrateLegacy(project); } catch (e) { if (e.code !== 'unavailable') console.warn('Legacy migration skipped:', e); }
    if (project !== currentProject || !isOnline()) return;
    unsubIssues = issuesCol(project).onSnapshot({ includeMetadataChanges: true }, snap => {
        if (project !== currentProject) return;
        issues = snap.docs.map(d => sanitizeIssue({ ...d.data(), id: d.id }));
        if (snap.metadata.hasPendingWrites) setSyncStatus('⏳ Saving...', 'warn');
        else if (snap.metadata.fromCache) setSyncStatus('📴 Offline – will sync', 'warn');
        else {
            setSyncStatus('☁️ Synced', 'ok');
            if (issues.some(i => !i.tag && i.createdByUid === me().uid)) numberPending(project);
        }
        renderIssues();
    }, e => handleCloudError(e, 'Issue sync error:'));
}

function subscribeMeta() {
    unsubs.forEach(u => u());
    unsubs = [
        metaRef('projects').onSnapshot(doc => {
            const list = doc.exists && doc.data().list;
            projects = (list && list.length) ? list : ['main'];
            if (!projects.includes(currentProject)) {
                currentProject = projects[0];
                subscribeIssues();
            }
            updateProjectDropdown();
        }, e => handleCloudError(e, 'Project sync error:')),
        metaRef('members').onSnapshot(doc => {
            members = (doc.exists && Array.isArray(doc.data().list)) ? doc.data().list : [];
            updateAssigneeOptions();
            renderIssues();
        }, e => console.warn('Member list unavailable:', e)),
        metaRef('settings').onSnapshot(doc => {
            settings = sanitizeSettings(doc.exists ? doc.data() : null);
        }, e => console.warn('Settings unavailable:', e))
    ];
}

// Add yourself to the team list so others can assign bugs to you.
async function registerMember() {
    const email = myEmail();
    if (!email) return;
    const name = clip(me().displayName || email, LIMITS.text);
    try {
        await db.runTransaction(async tx => {
            const snap = await tx.get(metaRef('members'));
            const list = (snap.exists && Array.isArray(snap.data().list)) ? snap.data().list : [];
            const existing = list.find(m => m.email === email);
            if (existing && existing.name === name) return;
            const next = list.filter(m => m.email !== email).concat({ email, name }).sort((a, b) => a.name.localeCompare(b.name));
            tx.set(metaRef('members'), { list: next });
        });
    } catch (e) {
        if (e.code === 'permission-denied') handleCloudError(e, 'Member error:');
        else console.warn('Could not register as member:', e);
    }
}

// After signing in, offer to move anything saved in this browser to the cloud.
async function offerLocalUpload() {
    const pending = Object.entries(local.issues).filter(([, arr]) => arr && arr.length);
    const total = pending.reduce((s, [, arr]) => s + arr.length, 0);
    if (!total) return;
    if (!confirm(`You have ${total} issue(s) saved only in this browser. Upload them to the cloud now?\n(They get new BUG numbers.)`)) return;
    try {
        setSyncStatus('⏳ Uploading...', 'warn');
        for (const [project, arr] of pending) {
            await db.runTransaction(async tx => {
                const snap = await tx.get(metaRef('projects'));
                const list = (snap.exists && snap.data().list) || ['main'];
                if (!list.includes(project)) list.push(project);
                tx.set(metaRef('projects'), { list });
            });
            await commitInBatches(arr.map(raw => {
                const i = sanitizeIssue(raw);
                return b => b.set(issuesCol(project).doc(i.id), { ...i, tag: '', createdByUid: me().uid, createdBy: i.createdBy || who() });
            }));
            await numberPending(project);
            delete local.issues[project];
            writeLocal();
        }
        toast(`Uploaded ${total} issue(s) to the cloud.`);
    } catch (e) { handleCloudError(e, 'Upload error:'); }
}

// ==========================================
// Firebase Initialization
// ==========================================
try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    // Cache cloud data on this device so edits made offline sync later.
    db.enablePersistence({ synchronizeTabs: true }).catch(e => console.info('Offline cache unavailable:', e.code));
    auth = firebase.auth();

    auth.onAuthStateChanged(async user => {
        const btn = $('authBtn');
        if (unsubIssues) unsubIssues();
        unsubs.forEach(u => u());
        unsubIssues = null;
        unsubs = [];
        selectedIssues.clear();
        if (user) {
            btn.innerText = '🚪 Sign out';
            btn.title = `Signed in as ${user.email || 'user'}`;
            setSyncStatus('⏳ Connecting...', 'warn');
            await registerMember();
            await offerLocalUpload();
            cloudStore.load();
        } else {
            btn.innerText = '🔑 Sign in';
            btn.title = 'Sign in with Google to save to the cloud';
            setSyncStatus('💾 Saved in this browser', 'warn');
            localStore.load();
        }
    });
} catch (e) {
    console.warn("Firebase init failed. Missing config.", e);
    setSyncStatus('💾 Saved in this browser', 'warn');
}

function toggleAuth() {
    if (!auth) return toast('Firebase is not configured.');
    if (auth.currentUser) return auth.signOut();
    auth.signInWithPopup(new firebase.auth.GoogleAuthProvider())
        .catch(e => {
            if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
            console.error('Sign-in error:', e);
            toast('Sign-in failed: ' + e.message);
        });
}

// ==========================================
// UI & Rendering
// ==========================================
function updateProjectDropdown() {
    const select = $('projectSelect');
    select.innerHTML = '';
    projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        if (p === currentProject) opt.selected = true;
        select.appendChild(opt);
    });
}

function updateAssigneeOptions() {
    const sel = $('assignee');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Unassigned</option>' +
        members.map(m => `<option value="${esc(m.email)}">${esc(m.name)}</option>`).join('');
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
    $('filterAssignee').disabled = !isOnline();
}

function updateMilestoneFilter() {
    const filter = $('filterMilestone');
    const currentVal = filter.value;
    const milestones = milestonesOf(issues);
    filter.innerHTML = '<option value="all">All Milestones</option>' +
        milestones.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    filter.value = milestones.includes(currentVal) ? currentVal : 'all';
    $('milestoneList').innerHTML = milestones.map(m => `<option value="${esc(m)}"></option>`).join('');
}

const btnCls = 'text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white transition';

function buildIssueCardHTML(issue) {
    const isSelected = selectedIssues.has(issue.id);
    const statusOpacity = issue.status === 'fixed' ? 'opacity-60 grayscale hover:grayscale-0 focus-within:grayscale-0' : '';
    const borderCol = isSelected ? 'border-blue-500 ring-2 ring-blue-500' : 'border-gray-200 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500';
    const htmlParsed = DOMPurify.sanitize(marked.parse(issue.desc));
    const sid = esc(issue.id);
    const label = esc(issue.tag || 'new issue');

    const tagsHtml = parseTags(issue.tags).map(t => `<span class="text-[10px] bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-1.5 py-0.5 rounded">${esc(t)}</span>`).join('');

    const notesHtml = issue.notes.length ? `<ul class="mt-3 pt-2 border-t border-gray-200 dark:border-gray-700 space-y-1" aria-label="Notes">
            ${issue.notes.map(n => `<li class="text-xs text-gray-600 dark:text-gray-400 group/note">
                <span class="font-bold">${esc(n.date)}${n.author ? ' · ' + esc(n.author) : ''}:</span> ${esc(n.text)}${n.edited ? ' <em class="opacity-70">(edited)</em>' : ''}
                <button type="button" data-action="editNote" data-id="${sid}" data-note="${esc(n.id)}" class="ml-1 underline opacity-70 hover:opacity-100">edit</button>
                <button type="button" data-action="deleteNote" data-id="${sid}" data-note="${esc(n.id)}" class="ml-1 underline opacity-70 hover:opacity-100 text-red-600 dark:text-red-400">delete</button>
            </li>`).join('')}
        </ul>` : '';

    const historyHtml = issue.history.length ? `<details class="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
            <summary class="cursor-pointer select-none">History (${issue.history.length})</summary>
            <ul class="mt-1 space-y-0.5 pl-3 border-l border-gray-300 dark:border-gray-600">
                ${[...issue.history].reverse().map(h => `<li>${esc(formatDate(h.at))} · <b>${esc(h.by)}</b>: ${esc(h.text)}</li>`).join('')}
            </ul>
        </details>` : '';

    const meta = [
        issue.createdBy && `Logged by ${esc(issue.createdBy)}`,
        issue.updatedBy && issue.updatedAt && `updated by ${esc(issue.updatedBy)} ${esc(formatDate(issue.updatedAt))}`
    ].filter(Boolean).join(', ');

    return `
        <article id="card-${sid}" data-issue="${sid}" aria-label="${label}" class="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border ${borderCol} transition-all relative group ${statusOpacity}" draggable="true">
            <div class="absolute top-2 right-2">
                <input type="checkbox" data-action="toggleSelection" data-id="${sid}" aria-label="Select ${label}" class="w-4 h-4 cursor-pointer ${isSelected ? '' : 'opacity-30 group-hover:opacity-100 focus:opacity-100'}" ${isSelected ? 'checked' : ''}>
            </div>

            <div class="flex flex-wrap gap-2 items-center mb-2 pr-6">
                <span class="text-[10px] font-mono font-bold text-gray-500 dark:text-gray-400" title="${issue.tag ? '' : 'Gets a number when synced'}">${esc(issue.tag || 'NEW')}</span>
                <span class="text-[10px] uppercase font-bold px-2 py-0.5 rounded border ${getImpactColor(issue.impact)}">${getImpactLabel(issue.impact)}</span>
                ${issue.points ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-200 border border-yellow-300 dark:border-yellow-800" title="Story Points">⭐ ${esc(issue.points)}</span>` : ''}
                ${issue.milestone ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-200 border border-purple-300 dark:border-purple-800" title="Milestone">🎯 ${esc(issue.milestone)}</span>` : ''}
                ${issue.assignee ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200 border border-sky-300 dark:border-sky-800" title="Assignee">👤 ${esc(memberName(issue.assignee))}</span>` : ''}
                <span class="text-xs text-blue-700 dark:text-blue-300 font-mono bg-blue-100 dark:bg-blue-900/30 px-2 py-0.5 rounded">${esc(issue.subject)}</span>
            </div>

            <div class="markdown-prose text-sm text-gray-800 dark:text-gray-200 break-words mb-3">${htmlParsed}</div>

            ${tagsHtml ? `<div class="flex flex-wrap gap-1 mb-2">${tagsHtml}</div>` : ''}
            ${notesHtml}
            ${meta ? `<div class="mt-2 text-[10px] text-gray-500 dark:text-gray-400">${meta}</div>` : ''}
            ${historyHtml}

            <div class="mt-3 flex flex-wrap gap-2 pt-3 border-t border-gray-100 dark:border-gray-700">
                <select data-change="status" data-id="${sid}" aria-label="Status of ${label}" class="text-xs bg-gray-100 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 outline-none text-gray-800 dark:text-white">
                    ${STATUSES.map(s => `<option value="${s}" ${issue.status === s ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
                </select>
                <button type="button" data-action="editIssue" data-id="${sid}" class="${btnCls}" aria-label="Edit ${label}">Edit</button>
                <button type="button" data-action="addNote" data-id="${sid}" class="${btnCls}" aria-label="Add note to ${label}">Note</button>
                <button type="button" data-action="askClaude" data-id="${sid}" class="text-xs px-2 py-1 rounded bg-[#F0E6D2] text-[#6B5B3E] hover:bg-[#E6D5B8] dark:bg-[#3D382D] dark:text-[#D4C5A9] dark:hover:bg-[#4D4638] font-medium transition" title="Copy prompt and open Claude">🤖 Claude</button>
            </div>
        </article>
    `;
}

function renderIssues() {
    // Drop selections for issues that no longer exist (e.g. deleted by a teammate)
    const ids = new Set(issues.map(i => i.id));
    selectedIssues.forEach(id => { if (!ids.has(id)) selectedIssues.delete(id); });
    updateBulkActionBar();

    updateMilestoneFilter();
    const filtered = filterIssues(issues, {
        status: $('filterStatus').value,
        impact: $('filterImpact').value,
        milestone: $('filterMilestone').value,
        assignee: $('filterAssignee').value,
        me: myEmail(),
        query: $('searchBar').value
    });

    const empty = `<p class="text-gray-500 dark:text-gray-400 italic mt-4">${issues.length ? 'No issues match current filters.' : 'No issues yet. Log one to get started!'}</p>`;
    if (isKanban) {
        const columns = { open: [], in_progress: [], fixed: [] };
        filtered.forEach(i => columns[i.status].push(buildIssueCardHTML(i)));
        $('kb-open').innerHTML = columns.open.join('');
        $('kb-in_progress').innerHTML = columns.in_progress.join('');
        $('kb-fixed').innerHTML = columns.fixed.join('');
        $('kb-open-count').innerText = columns.open.length;
        $('kb-prog-count').innerText = columns.in_progress.length;
        $('kb-fixed-count').innerText = columns.fixed.length;
        $('gridView').innerHTML = '';
    } else {
        $('gridView').innerHTML = filtered.length ? filtered.map(buildIssueCardHTML).join('') : empty;
        ['kb-open', 'kb-in_progress', 'kb-fixed'].forEach(id => { $(id).innerHTML = ''; });
    }

    const pct = progressPct(issues);
    $('progressBar').style.width = `${pct}%`;
    $('progressWrap').setAttribute('aria-valuenow', pct);
}

// ==========================================
// Issue form
// ==========================================
function showForm(show) {
    $('formPanel').classList.toggle('hidden', !show);
    $('newIssueBtn').setAttribute('aria-expanded', String(show));
    $('newIssueBtn').innerText = show ? '✖ Close form' : '➕ New Issue';
}

$('issueForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('editId').value;
    const fields = {
        desc: $('desc').value,
        subject: $('subject').value,
        impact: $('impact').value,
        points: $('points').value,
        milestone: $('milestone').value.trim(),
        assignee: $('assignee').value,
        tags: $('tags').value
    };
    clearForm();
    if (id) {
        store().update(id, fields);
    } else {
        const issue = sanitizeIssue({ ...fields, id: newId(), status: 'open', notes: [], createdBy: who(), createdAt: Date.now() });
        issue.history = withHistory([], who(), 'created');
        store().create(issue);
    }
    if (window.matchMedia('(max-width: 1279px)').matches) showForm(false);
});

function editIssue(id) {
    const issue = issues.find(i => i.id === id);
    if (!issue) return;
    $('editId').value = issue.id;
    $('desc').value = issue.desc;
    $('subject').value = issue.subject;
    $('impact').value = issue.impact;
    $('points').value = issue.points || '';
    $('milestone').value = issue.milestone || '';
    $('assignee').value = issue.assignee || '';
    $('tags').value = issue.tags || '';

    $('formTitle').innerText = `Editing ${issue.tag || 'Issue'}`;
    $('submitBtn').innerText = "Update Issue";
    $('cancelEditBtn').classList.remove('hidden');
    showForm(true);
    $('formPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('desc').focus({ preventScroll: true });
}

function clearForm() {
    $('issueForm').reset();
    $('editId').value = "";
    $('formTitle').innerText = "Log Issue";
    $('submitBtn').innerText = "Save Issue";
    $('cancelEditBtn').classList.add('hidden');
}

function updateStatus(id, newStatus) {
    const it = issues.find(i => i.id === id);
    if (!STATUSES.includes(newStatus) || !it || it.status === newStatus) return;
    store().setStatus(new Set([id]), newStatus);
}

// ==========================================
// Notes
// ==========================================
function openNoteModal(issueId, noteId) {
    const issue = issues.find(i => i.id === issueId);
    if (!issue) return;
    const note = noteId ? issue.notes.find(n => n.id === noteId) : null;
    noteTarget = { issueId, noteId: note ? note.id : null };
    $('noteTitle').innerText = note ? `Edit note on ${issue.tag || 'issue'}` : `Add note to ${issue.tag || 'issue'}`;
    $('noteText').value = note ? note.text : '';
    openModal('noteModal', 'noteText');
}

$('noteForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('noteText').value.trim();
    if (!text || !noteTarget) return;
    const { issueId, noteId } = noteTarget;
    closeModals();
    if (noteId) {
        store().setNotes(issueId, notes => notes.map(n => n.id === noteId ? { ...n, text, edited: true } : n), 'note edited');
    } else {
        store().addNote(issueId, { id: newId(), text, date: formatDate(Date.now()), author: isOnline() ? who() : '', edited: false });
    }
});

function deleteNote(issueId, noteId) {
    if (!confirm('Delete this note?')) return;
    store().setNotes(issueId, notes => notes.filter(n => n.id !== noteId), 'note deleted');
}

// ==========================================
// View, theme
// ==========================================
function toggleView() {
    isKanban = !isKanban;
    $('gridView').classList.toggle('hidden', isKanban);
    $('kanbanView').classList.toggle('hidden', !isKanban);
    $('toggleViewBtn').innerText = isKanban ? "📄 Grid" : "📋 Kanban";
    try { localStorage.setItem('view', isKanban ? 'kanban' : 'grid'); } catch (e) {}
    renderIssues();
}

function toggleTheme() {
    const dark = document.documentElement.classList.toggle('dark');
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
}

// ==========================================
// Screenshots (Firebase Storage)
// ==========================================
function insertAtCursor(ta, text) {
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + text.length;
    ta.focus();
}

async function uploadImage(file) {
    const problem = checkImageFile(file);
    if (problem) return toast(problem);
    if (!isOnline()) {
        const url = prompt("Screenshot uploads need you to be signed in.\nYou can paste an image link (https://...) instead:");
        if (url && /^https:\/\//i.test(url)) insertAtCursor($('desc'), `\n![Screenshot](${url.replace(/[()\s]/g, encodeURIComponent)})\n`);
        else if (url) toast('Please paste a link starting with https://');
        return;
    }
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[file.type];
    const placeholder = `![Uploading ${newId().slice(0, 8)}…]()`;
    insertAtCursor($('desc'), `\n${placeholder}\n`);
    try {
        const ref = firebase.storage().ref(`workspaces/${WORKSPACE}/images/${newId()}.${ext}`);
        await ref.put(file, { contentType: file.type, customMetadata: { uploadedBy: myEmail() } });
        const url = await ref.getDownloadURL();
        $('desc').value = $('desc').value.replace(placeholder, `![Screenshot](${url})`);
    } catch (e) {
        $('desc').value = $('desc').value.replace(`\n${placeholder}\n`, '');
        console.error('Upload error:', e);
        toast(e.code === 'storage/unauthorized' ? 'Upload not allowed. Check storage.rules.' : 'Screenshot upload failed: ' + e.message);
    }
}

$('imageFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) uploadImage(file);
});

$('desc').addEventListener('paste', (e) => {
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    uploadImage(item.getAsFile());
});

// ==========================================
// Bulk Actions & Undo
// ==========================================
function toggleSelection(id) {
    if (selectedIssues.has(id)) selectedIssues.delete(id);
    else selectedIssues.add(id);
    renderIssues();
    const box = document.querySelector(`[data-action="toggleSelection"][data-id="${CSS.escape(id)}"]`);
    if (box) box.focus();
}

function updateBulkActionBar() {
    $('bulkCount').innerText = selectedIssues.size;
    $('bulkActionBar').classList.toggle('translate-y-full', selectedIssues.size === 0);
}

function clearSelection() {
    selectedIssues.clear();
    renderIssues();
}

function bulkUpdateStatus(status) {
    const ids = new Set(selectedIssues);
    clearSelection();
    store().setStatus(ids, status);
}

function bulkDelete() {
    const n = selectedIssues.size;
    if (!confirm(`Delete ${n} issue(s)?`)) return;
    const ids = new Set(selectedIssues);
    const project = currentProject;
    const st = store();
    clearSelection();
    const removed = st.remove(ids);
    toast(`Deleted ${n} issue(s).`, 'Undo', () => {
        if (currentProject !== project || store() !== st) return toast('Undo is only available in the same project.');
        st.restore(removed);
        toast(`Restored ${removed.length} issue(s).`);
    }, 10000);
}

// ==========================================
// Drag and Drop (Kanban). Keyboard users can use each card's status menu.
// ==========================================
document.addEventListener('dragstart', (e) => {
    const card = e.target.closest && e.target.closest('[data-issue]');
    if (card) e.dataTransfer.setData('text/plain', card.dataset.issue);
});
document.addEventListener('dragover', (e) => {
    const zone = e.target.closest && e.target.closest('[data-drop]');
    if (!zone) return;
    e.preventDefault();
    zone.classList.add('drag-over');
});
document.addEventListener('dragleave', (e) => {
    const zone = e.target.closest && e.target.closest('[data-drop]');
    if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
});
document.addEventListener('drop', (e) => {
    const zone = e.target.closest && e.target.closest('[data-drop]');
    if (!zone) return;
    e.preventDefault();
    zone.classList.remove('drag-over');
    updateStatus(e.dataTransfer.getData('text/plain'), zone.dataset.drop);
});

// ==========================================
// Integrations
// ==========================================
async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try { await navigator.clipboard.writeText(text); return; } catch (e) { /* fall back */ }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.className = 'fixed opacity-0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
}

async function askClaude(id) {
    const issue = issues.find(i => i.id === id);
    if (!issue) return;
    await copyText(buildClaudePrompt(settings, issue));
    toast('Prompt copied! Paste it into Claude.');
    window.open('https://claude.ai/new', '_blank', 'noopener');
}

function applyCategory(result) {
    if (result && SUBJECTS.includes(result.subject)) $('subject').value = result.subject;
    if (result && ['1', '2', '3', '4'].includes(String(result.impact))) $('impact').value = String(result.impact);
}

// Preferred: the team's server function (key never reaches the browser).
// Fallback: a personal Gemini key stored in this browser.
async function categorizeViaFunction(desc) {
    if (!isOnline() || !firebase.functions) return null;
    try {
        const res = await firebase.functions().httpsCallable('categorize', { timeout: 20000 })({ desc });
        return res.data;
    } catch (e) {
        if (['functions/permission-denied', 'functions/unauthenticated', 'functions/invalid-argument', 'functions/resource-exhausted'].includes(e.code)) throw e;
        console.info('Server categorize unavailable, falling back to personal key:', e.code);
        return null;
    }
}

async function categorizeViaKey(desc) {
    let userApiKey = null;
    try { userApiKey = localStorage.getItem('gemini_api_key'); } catch (e) {}
    if (!userApiKey) {
        userApiKey = prompt("Enter your Gemini API Key to enable AI categorization.\n(It is stored only in this browser. Your team can avoid this by deploying the server function, see README.)");
        if (!userApiKey) return null;
        try { localStorage.setItem('gemini_api_key', userApiKey); } catch (e) {}
    }
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': userApiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: buildCategorizePrompt(desc) }] }] })
    });
    if (!response.ok) {
        if (response.status === 400 || response.status === 403) {
            try { localStorage.removeItem('gemini_api_key'); } catch (e) {}
            throw new Error("Invalid API Key. Your saved key has been cleared. Please try again.");
        }
        throw new Error("API request failed with status " + response.status);
    }
    const data = await response.json();
    return parseAiJson(data.candidates[0].content.parts[0].text);
}

async function autoCategorize() {
    const desc = $('desc').value;
    if (!desc || desc.length < 5) return toast("Please type a description first!");
    const btn = $('aiBtn');
    const originalText = btn.innerText;
    btn.innerText = "⏳ Thinking...";
    btn.disabled = true;
    try {
        const result = (await categorizeViaFunction(desc)) || (await categorizeViaKey(desc));
        if (result) { applyCategory(result); toast('Subject and priority suggested.'); }
    } catch (e) {
        console.error("AI Error:", e);
        toast(e.message || "AI generation failed. Check console.");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

// ==========================================
// Modals (focus is trapped inside and restored on close)
// ==========================================
let modalReturnFocus = null;
const openModalEl = () => document.querySelector('[role="dialog"].flex');

function openModal(id, focusId) {
    modalReturnFocus = document.activeElement;
    $(id).classList.remove('hidden');
    $(id).classList.add('flex');
    const target = focusId ? $(focusId) : $(id).querySelector('input, textarea, button');
    if (target) target.focus();
}

function closeModals() {
    document.querySelectorAll('[role="dialog"]').forEach(m => { m.classList.add('hidden'); m.classList.remove('flex'); });
    if (modalReturnFocus && document.contains(modalReturnFocus)) modalReturnFocus.focus();
    modalReturnFocus = null;
}

document.addEventListener('keydown', (e) => {
    const modal = openModalEl();
    if (!modal) return;
    if (e.key === 'Escape') { e.preventDefault(); closeModals(); return; }
    if (e.key !== 'Tab') return;
    const focusables = [...modal.querySelectorAll('button, input, textarea, select, [href]')].filter(el => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// Click on the dark backdrop closes the modal
document.querySelectorAll('[role="dialog"]').forEach(m => m.addEventListener('mousedown', (e) => { if (e.target === m) closeModals(); }));

function openProjectModal(mode) {
    projectModalMode = mode;
    $('projectModalTitle').innerText = mode === 'add' ? 'Create New Project' : 'Rename Project';
    $('projectModalInput').value = mode === 'edit' ? currentProject : '';
    openModal('projectModal', 'projectModalInput');
}

async function confirmProjectModal() {
    const input = normalizeProjectName($('projectModalInput').value);
    if (!input) return toast("Use letters, numbers, spaces, - or _.");
    const oldName = currentProject;
    if (input !== oldName && projects.includes(input)) return toast("A project with that name already exists.");
    closeModals();
    if (projectModalMode === 'add' && input !== oldName) await store().addProject(input);
    else if (projectModalMode === 'edit' && input !== oldName) await store().renameProject(oldName, input);
}

$('projectModalInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmProjectModal(); });

function openSettings() {
    $('setEngine').value = settings.engine;
    $('setGenre').value = settings.genre;
    $('setLanguage').value = settings.language;
    openModal('settingsModal', 'setEngine');
}

$('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = sanitizeSettings({ engine: $('setEngine').value, genre: $('setGenre').value, language: $('setLanguage').value });
    closeModals();
    await store().saveSettings(s);
    toast('Settings saved.');
});

// ==========================================
// Import/Export Backup
// ==========================================
function exportData() {
    const blob = new Blob([JSON.stringify(issues, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tracker_backup_${currentProject}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('importFile').addEventListener('change', (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        let imported;
        try { imported = validateImport(JSON.parse(e.target.result)); }
        catch (err) { return toast("Invalid JSON file."); }
        if (!imported) return toast("File is not a valid tracker backup.");
        if (!confirm(`Replace all ${issues.length} issues in "${currentProject}" with ${imported.length} imported issues?`)) return;
        let next = nextBugNumber(imported);
        imported.forEach(i => { if (!i.tag) i.tag = fmtBug(next++); });
        await store().replaceAll(imported);
        toast("Data restored successfully!");
    };
    reader.readAsText(file);
});

// ==========================================
// Event wiring (no inline handlers, so the CSP can forbid them)
// ==========================================
const actions = {
    openProjectModal: (el) => openProjectModal(el.dataset.mode),
    confirmProjectModal: () => confirmProjectModal(),
    toggleAuth: () => toggleAuth(),
    openSettings: () => openSettings(),
    toggleTheme: () => toggleTheme(),
    openShareModal: () => openModal('shareModal'),
    closeModals: () => closeModals(),
    exportData: () => exportData(),
    pickImport: () => $('importFile').click(),
    toggleView: () => toggleView(),
    toggleForm: () => showForm($('formPanel').classList.contains('hidden')),
    cancelForm: () => { clearForm(); if (window.matchMedia('(max-width: 1279px)').matches) showForm(false); },
    pickImage: () => $('imageFile').click(),
    autoCategorize: () => autoCategorize(),
    bulkUpdateStatus: (el) => bulkUpdateStatus(el.dataset.status),
    bulkDelete: () => bulkDelete(),
    clearSelection: () => clearSelection(),
    toastAction: () => { const cb = toastCallback; hideToast(); if (cb) cb(); },
    toggleSelection: (el) => toggleSelection(el.dataset.id),
    editIssue: (el) => editIssue(el.dataset.id),
    addNote: (el) => openNoteModal(el.dataset.id),
    editNote: (el) => openNoteModal(el.dataset.id, el.dataset.note),
    deleteNote: (el) => deleteNote(el.dataset.id, el.dataset.note),
    askClaude: (el) => askClaude(el.dataset.id),
    forgetGeminiKey: () => { try { localStorage.removeItem('gemini_api_key'); } catch (e) {} toast('Gemini key removed from this browser.'); }
};

document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !actions[el.dataset.action]) return;
    actions[el.dataset.action](el, e);
});

document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-change="status"]');
    if (el) updateStatus(el.dataset.id, el.value);
});

$('projectSelect').addEventListener('change', (e) => {
    currentProject = e.target.value;
    selectedIssues.clear();
    if (isOnline()) subscribeIssues(); else localStore.load();
});

['filterStatus', 'filterImpact', 'filterMilestone', 'filterAssignee'].forEach(id => $(id).addEventListener('change', renderIssues));
$('searchBar').addEventListener('input', renderIssues);

// --- Initial render ---
try { if (localStorage.getItem('view') === 'kanban') toggleView(); } catch (e) {}
if (!auth) localStore.load();
else renderIssues();
