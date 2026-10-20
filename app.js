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
const CONFIG_KEY = 'btp_config';
let config = sanitizeConfig(null); // { subjects, milestones } — editable in ⚙️ Settings
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
        try { config = sanitizeConfig(JSON.parse(localStorage.getItem(CONFIG_KEY))); } catch (e) { config = sanitizeConfig(null); }
        updateSubjectOptions();
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
    saveConfig(cfg) {
        config = cfg;
        try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) {}
        updateSubjectOptions();
        renderIssues();
    },
    // Every issue in every project: [{ project, issue }]
    async allIssues() {
        return Object.entries(local.issues).flatMap(([project, arr]) => (arr || []).map(raw => ({ project, issue: sanitizeIssue(raw) })));
    },
    // Applies fn(issue) -> changed fields | null to every issue in every project.
    rewriteIssues(fn) {
        let n = 0;
        Object.keys(local.issues).forEach(p => {
            local.issues[p] = (local.issues[p] || []).map(raw => {
                const it = sanitizeIssue(raw);
                const out = fn(it);
                if (!out) return raw;
                n++;
                return { ...it, ...out, history: withHistory(it.history, who(), describeChanges(it, out)), updatedBy: who(), updatedAt: Date.now() };
            });
        });
        writeLocal();
        this.load();
        return n;
    }
};

// ==========================================
// Cloud storage (Firestore, one document per issue)
//   workspaces/{ws}/meta/projects            { list: [...] }
//   workspaces/{ws}/meta/members             { list: [{ email, name }] }
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
    async saveConfig(cfg) {
        config = cfg;
        updateSubjectOptions();
        renderIssues();
        try { await metaRef('config').set(cfg); } catch (e) { handleCloudError(e, 'Settings error:'); }
    },
    async allIssues() {
        const out = [];
        for (const project of projects) {
            const snap = await issuesCol(project).get();
            snap.docs.forEach(d => out.push({ project, issue: sanitizeIssue({ ...d.data(), id: d.id }) }));
        }
        return out;
    },
    async rewriteIssues(fn) {
        let n = 0;
        try {
            setSyncStatus('⏳ Updating issues...', 'warn');
            for (const p of projects) {
                const snap = await issuesCol(p).get();
                const ops = [];
                snap.docs.forEach(d => {
                    const it = sanitizeIssue({ ...d.data(), id: d.id });
                    const out = fn(it);
                    if (!out) return;
                    n++;
                    const history = withHistory(it.history, who(), describeChanges(it, out));
                    ops.push(b => b.update(d.ref, { ...out, history, updatedBy: who(), updatedAt: Date.now() }));
                });
                await commitInBatches(ops);
            }
            setSyncStatus('☁️ Synced', 'ok');
        } catch (e) { handleCloudError(e, 'Update error:'); }
        return n;
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
        metaRef('config').onSnapshot(doc => {
            config = sanitizeConfig(doc.exists ? doc.data() : null);
            updateSubjectOptions();
            renderIssues();
        }, e => console.warn('Settings unavailable:', e)),
        metaRef('members').onSnapshot(doc => {
            members = (doc.exists && Array.isArray(doc.data().list)) ? doc.data().list : [];
            updateAssigneeOptions();
            renderIssues();
        }, e => console.warn('Member list unavailable:', e))
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
}

function updateMilestoneList() {
    const all = [...new Set([...config.milestones, ...milestonesOf(issues)])];
    $('milestoneList').innerHTML = all.map(m => `<option value="${esc(m)}"></option>`).join('');
}

// Subjects offered in the form: the team list first, then any other
// single-topic subject a bug uses (e.g. after an import or a teammate's AI pick).
// Old combined subjects ("X & Y") are hidden once no bug here uses them.
function subjectChoices() {
    const used = new Set(issues.map(i => i.subject.toLowerCase()));
    const listed = config.subjects.filter(s => !isPlaceholderSubject(s) && (isSingleSubject(s) || used.has(s.toLowerCase())));
    const known = new Set(listed.map(s => s.toLowerCase()));
    const extra = [...new Set(issues.map(i => i.subject))]
        .filter(s => isSingleSubject(s) && !isPlaceholderSubject(s) && !known.has(s.toLowerCase()))
        .sort((a, b) => a.localeCompare(b));
    const all = [...listed, ...extra];
    return all.length ? all : [...SUBJECTS];
}

function updateSubjectOptions() {
    const sel = $('subject');
    const cur = sel.value;
    const choices = subjectChoices();
    // Rebuild only when the list changed, so an open form keeps its state
    if ([...sel.options].map(o => o.value).join('\n') === choices.join('\n')) return;
    sel.innerHTML = choices.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if (cur) { ensureSubjectOption(cur); sel.value = cur; }
}

// Keeps a subject selectable even if it isn't in the team list (yet).
function ensureSubjectOption(subject, isNew) {
    const sel = $('subject');
    if (!subject || [...sel.options].some(o => o.value === subject)) return;
    const opt = document.createElement('option');
    opt.value = subject;
    opt.textContent = `${subject} ${isNew ? '(new)' : '(not in list)'}`;
    sel.appendChild(opt);
}

// A subject the AI invented becomes part of the team list once a bug uses it.
const aiNewSubjects = new Set();
function adoptSubject(subject) {
    if (!subject || config.subjects.some(s => s.toLowerCase() === subject.toLowerCase())) return;
    if (!isSingleSubject(subject)) return; // old combined subjects aren't re-added
    store().saveConfig(sanitizeConfig({ ...config, subjects: [...config.subjects, subject] }));
    toast(`Added new subject “${subject}”.`);
}

// ==========================================
// ⚙️ Settings: edit subjects, milestones and tags.
// Changes are made on a draft and applied to all projects on Save.
// ==========================================
let settingsDraft = null;

function openSettings(section) {
    const used = (fn) => issues.reduce((m, i) => { fn(i).forEach(v => m.set(v, (m.get(v) || 0) + 1)); return m; }, new Map());
    const subjectUse = used(i => [i.subject]);
    const milestoneUse = used(i => i.milestone ? [i.milestone] : []);
    const tagUse = used(i => parseTags(i.tags).map(t => t.toLowerCase()));
    const row = (name, n) => ({ orig: name, name, n: n || 0, deleted: false });
    settingsDraft = {
        subjects: [...new Set([...config.subjects, ...issues.map(i => i.subject)])].map(s => row(s, subjectUse.get(s))),
        milestones: [...new Set([...config.milestones, ...milestonesOf(issues)])].map(m => row(m, milestoneUse.get(m))),
        tags: tagsOf(issues).map(t => row(t, tagUse.get(t.toLowerCase())))
    };
    renderSettings();
    renderAiSettings();
    openModal('settingsModal', section === 'ai' ? 'aiKeyInput' : undefined);
    if (section === 'ai') $('aiSettings').scrollIntoView({ block: 'start' });
}

const SETTINGS_SECTIONS = {
    subjects: { title: 'Subjects', hint: 'Shown in the form and used by the AI. The order here is the sort order. Deleting a subject moves its issues to the first subject.', max: LIMITS.subject, add: true, order: true },
    milestones: { title: 'Milestones', hint: 'Planned milestones appear in the form and the AI can pick them. Deleting one clears it from its issues.', max: LIMITS.milestone, add: true },
    tags: { title: 'Tags', hint: 'Rename to fix typos or merge two tags (give them the same name). Deleting removes the tag from its issues.', max: 30 }
};

function renderSettings() {
    const btn = 'text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-30';
    $('settingsBody').innerHTML = Object.entries(SETTINGS_SECTIONS).map(([list, s]) => {
        const rows = settingsDraft[list];
        return `
        <section class="space-y-2" aria-labelledby="set-${list}">
            <div class="flex items-center justify-between gap-2">
                <h3 id="set-${list}" class="font-bold text-gray-800 dark:text-white">${s.title}</h3>
                <div class="flex gap-1.5">
                    ${list === 'subjects' ? `<button type="button" data-action="openOrganize" class="text-xs px-2 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:hover:bg-blue-800/60" title="Let AI propose single-topic subjects and re-sort all bugs">🤖 Reorganize with AI</button>` : ''}
                    ${s.add ? `<button type="button" data-action="settingsAdd" data-list="${list}" class="${btn}">➕ Add</button>` : ''}
                </div>
            </div>
            <p class="text-xs text-gray-500 dark:text-gray-400">${s.hint} Counts are for the current project.</p>
            ${rows.length ? `<ul class="space-y-1.5">${rows.map((r, k) => `
                <li class="flex items-center gap-1.5 ${r.deleted ? 'opacity-50' : ''}">
                    <label class="sr-only" for="set-${list}-${k}">${s.title} ${k + 1}</label>
                    <input id="set-${list}-${k}" data-setting="${list}" data-idx="${k}" value="${esc(r.name)}" maxlength="${s.max}" ${r.deleted ? 'disabled' : ''}
                        class="flex-1 min-w-0 bg-gray-100 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded p-1.5 text-sm text-gray-800 dark:text-white outline-none focus:border-blue-500 ${r.deleted ? 'line-through' : ''}">
                    <span class="text-[10px] w-14 text-right text-gray-500 dark:text-gray-400" title="Issues in this project">${r.orig ? `${r.n} issue${r.n === 1 ? '' : 's'}` : 'new'}</span>
                    ${s.order ? `
                        <button type="button" data-action="settingsMove" data-list="${list}" data-idx="${k}" data-dir="-1" class="${btn}" aria-label="Move ${esc(r.name)} up" ${k === 0 ? 'disabled' : ''}>↑</button>
                        <button type="button" data-action="settingsMove" data-list="${list}" data-idx="${k}" data-dir="1" class="${btn}" aria-label="Move ${esc(r.name)} down" ${k === rows.length - 1 ? 'disabled' : ''}>↓</button>` : ''}
                    <button type="button" data-action="settingsDelete" data-list="${list}" data-idx="${k}" class="${btn} ${r.deleted ? '' : 'text-red-600 dark:text-red-400'}" aria-label="${r.deleted ? 'Restore' : 'Delete'} ${esc(r.name)}">${r.deleted ? '↺' : '🗑'}</button>
                </li>`).join('')}</ul>` : '<p class="text-xs italic text-gray-400">None yet.</p>'}
        </section>`;
    }).join('<hr class="border-gray-200 dark:border-gray-700">');
}

document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-setting]');
    if (el && settingsDraft) settingsDraft[el.dataset.setting][Number(el.dataset.idx)].name = el.value;
});

function settingsAdd(list) {
    settingsDraft[list].push({ orig: '', name: '', n: 0, deleted: false });
    renderSettings();
    const inputs = document.querySelectorAll(`[data-setting="${list}"]`);
    inputs[inputs.length - 1].focus();
}

function settingsMove(list, idx, dir) {
    const rows = settingsDraft[list];
    const to = idx + dir;
    if (to < 0 || to >= rows.length) return;
    [rows[idx], rows[to]] = [rows[to], rows[idx]];
    renderSettings();
    const b = document.querySelector(`[data-action="settingsMove"][data-list="${list}"][data-idx="${to}"][data-dir="${dir}"]`) ||
        document.querySelector(`[data-action="settingsMove"][data-list="${list}"][data-idx="${to}"]`);
    if (b) b.focus();
}

function settingsDelete(list, idx) {
    const r = settingsDraft[list][idx];
    if (!r.orig) settingsDraft[list].splice(idx, 1); // new, unsaved row: just drop it
    else r.deleted = !r.deleted;
    renderSettings();
}

// ==========================================
// 🤖 Reorganize with AI
// Step 1 designs a clean single-topic subject list from the bugs,
// step 2 assigns every bug a subject (+ tags). Nothing changes until Apply.
// ==========================================
let organizePlan = null; // { subjects, rows: [{ project, issue, subject, addTags, on }], skipped, total }

function organizeUI(status, mainLabel, mainAction, busy) {
    $('organizeStatus').innerText = status || '';
    const b = $('organizeMain');
    b.innerText = mainLabel;
    b.dataset.action = mainAction;
    b.disabled = !!busy;
}

function openOrganize() {
    closeModals();
    organizePlan = null;
    $('organizeTitle').innerText = '🤖 Reorganize subjects with AI';
    $('organizeBody').innerHTML = `
        <p>The AI reads <b>all bugs in all projects</b>, proposes a clean list of <b>single-topic subjects</b>
        (no more “X &amp; Y”), and suggests a subject and tags for every bug.</p>
        <ul class="list-disc pl-5 space-y-1 text-gray-600 dark:text-gray-400">
            <li>You see a preview first and can untick any bug before applying.</li>
            <li>Applying replaces the subject list in ⚙️ Settings and records the change in each bug's history.</li>
            <li>Bug descriptions are sent to Google Gemini.</li>
        </ul>`;
    organizeUI('', 'Start', 'startOrganize');
    openModal('organizeModal', 'organizeMain');
}

// Same AI path as ✨: team server function first, personal key as fallback.
async function organizeAsk(step, payload, promptText) {
    return (await callAiFunction('organize', { step, ...payload }, 120000)) || (await askGemini(promptText));
}

async function startOrganize() {
    try {
        organizeUI('Reading bugs…', 'Working…', 'startOrganize', true);
        const all = (await store().allIssues()).filter(x => x.issue.desc.trim());
        if (all.length < 2) { organizeUI('There are not enough bugs to organize yet.', 'Start', 'startOrganize'); return; }
        const items = all.map((x, i) => ({ i, text: organizeText(x.issue) }));
        const tags = tagsOf(all.map(x => x.issue));

        // Step 1: subject list from an evenly spread sample
        const sampleSize = Math.min(items.length, ORGANIZE_SAMPLE);
        organizeUI(`Step 1 of 2: designing subjects from ${sampleSize} bugs…`, 'Working…', 'startOrganize', true);
        const stride = items.length / sampleSize;
        const sample = Array.from({ length: sampleSize }, (_, k) => items[Math.floor(k * stride)]);
        const raw = await organizeAsk('taxonomy', { items: sample, subjects: config.subjects }, buildTaxonomyPrompt(sample, config.subjects));
        if (!raw) { organizeUI('', 'Start', 'startOrganize'); return; } // key prompt cancelled
        const subjects = parseTaxonomy(raw);
        if (subjects.length < 2) throw new Error('The AI did not return a usable subject list. Try again.');

        // Step 2: assign every bug, in batches; one retry for any it skipped
        const assigned = new Map();
        for (let pass = 0; pass < 2 && assigned.size < items.length; pass++) {
            const todo = chunk(items.filter(it => !assigned.has(it.i)), ORGANIZE_BATCH);
            for (let b = 0; b < todo.length; b++) {
                organizeUI(`Step 2 of 2: sorting bugs ${pass ? '(retry) ' : ''}— batch ${b + 1} of ${todo.length}…`, 'Working…', 'startOrganize', true);
                const res = await organizeAsk('assign', { items: todo[b], subjects, tags }, buildAssignPrompt(todo[b], subjects, tags));
                parseAssignments(res, todo[b].map(it => it.i), subjects, tags).forEach((v, k) => assigned.set(k, v));
            }
        }

        organizePlan = {
            subjects,
            rows: all.map((x, i) => {
                const a = assigned.get(i);
                if (!a) return null;
                const have = parseTags(x.issue.tags).map(t => t.toLowerCase());
                const addTags = a.tags.filter(t => !have.includes(t.toLowerCase()));
                if (a.subject === x.issue.subject && !addTags.length) return null;
                return { project: x.project, issue: x.issue, subject: a.subject, addTags, on: true };
            }).filter(Boolean),
            all: all.map(x => x.issue),
            skipped: items.length - assigned.size,
            total: items.length
        };
        renderOrganizePreview();
    } catch (e) {
        console.error('Organize error:', e);
        organizeUI(e.message || 'Something went wrong.', 'Try again', 'startOrganize');
    }
}

function renderOrganizePreview() {
    const p = organizePlan;
    const multi = new Set(p.rows.map(r => r.project)).size > 1;
    const on = p.rows.filter(r => r.on).length;
    const counts = p.rows.reduce((m, r) => { m[r.subject] = (m[r.subject] || 0) + 1; return m; }, {});
    $('organizeBody').innerHTML = `
        <div>
            <h3 class="font-bold mb-1.5">New subjects (${p.subjects.length})</h3>
            <div class="flex flex-wrap gap-1.5">${p.subjects.map(s => `<span class="text-xs px-2.5 py-1 rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200">${esc(s)} <span class="opacity-70">${counts[s] || 0}</span></span>`).join('')}</div>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-1.5">Numbers show how many bugs move into each subject. You can rename or reorder subjects afterwards in ⚙️ Settings.</p>
        </div>
        <div>
            <div class="flex items-center justify-between gap-2 mb-1.5">
                <h3 class="font-bold">Changes (${on} of ${p.rows.length} selected)</h3>
                <div class="text-xs flex gap-3">
                    <button type="button" data-action="organizeAll" data-on="1" class="underline hover:text-blue-600">Select all</button>
                    <button type="button" data-action="organizeAll" data-on="0" class="underline hover:text-blue-600">Select none</button>
                </div>
            </div>
            ${p.rows.length ? `<ul class="divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded">
                ${p.rows.map((r, k) => `
                <li class="flex gap-3 items-start p-2 ${r.on ? '' : 'opacity-50'}">
                    <input type="checkbox" data-action="organizeToggle" data-idx="${k}" ${r.on ? 'checked' : ''} class="mt-1 w-4 h-4" aria-label="Apply change to ${esc(r.issue.tag || 'new issue')}">
                    <div class="min-w-0 flex-1">
                        <div class="text-xs text-gray-500 dark:text-gray-400 font-mono">${esc(r.issue.tag || 'NEW')}${multi ? ` · ${esc(r.project)}` : ''}</div>
                        <div class="truncate" title="${esc(r.issue.desc)}">${esc(r.issue.desc)}</div>
                        <div class="text-xs mt-0.5">
                            ${r.subject !== r.issue.subject
                                ? `<span class="line-through opacity-60">${esc(r.issue.subject)}</span> → <b class="text-blue-700 dark:text-blue-300">${esc(r.subject)}</b>`
                                : `<span class="opacity-60">${esc(r.subject)} (unchanged)</span>`}
                            ${r.addTags.length ? ` · tags + ${r.addTags.map(esc).join(', ')}` : ''}
                        </div>
                    </div>
                </li>`).join('')}
            </ul>` : '<p class="italic text-gray-500">Every bug already fits the new subjects.</p>'}
            ${p.skipped ? `<p class="text-xs text-amber-600 dark:text-amber-400 mt-2">The AI skipped ${p.skipped} bug(s); they keep their current subject.</p>` : ''}
        </div>`;
    organizeUI(`${p.total} bugs analysed.`, `Apply to ${on} bug${on === 1 ? '' : 's'}`, 'applyOrganize');
}

async function applyOrganize() {
    const p = organizePlan;
    const chosen = new Map(p.rows.filter(r => r.on).map(r => [r.issue.id, r]));
    if (!confirm(`Replace the subject list with ${p.subjects.length} new subjects and update ${chosen.size} bug(s)?`)) return;
    organizeUI('Applying…', 'Working…', 'applyOrganize', true);
    // Keep single-topic subjects that bugs left unchanged still use (combined ones are dropped)
    const stillUsed = p.all.filter(i => !chosen.has(i.id)).map(i => i.subject)
        .filter(s => isSingleSubject(s) && !p.subjects.some(x => x.toLowerCase() === s.toLowerCase()));
    await store().saveConfig(sanitizeConfig({ ...config, subjects: [...p.subjects, ...new Set(stillUsed)] }));
    const n = chosen.size ? await store().rewriteIssues(i => {
        const r = chosen.get(i.id);
        if (!r) return null;
        const out = {};
        if (r.subject !== i.subject) out.subject = r.subject;
        if (r.addTags.length) {
            const merged = parseTags(i.tags);
            r.addTags.forEach(t => { if (!merged.some(m => m.toLowerCase() === t.toLowerCase())) merged.push(t); });
            out.tags = clip(merged.join(', '), LIMITS.tags);
        }
        return Object.keys(out).length ? out : null;
    }) : 0;
    organizePlan = null;
    closeModals();
    toast(`Subjects reorganized. ${n} bug${n === 1 ? '' : 's'} updated.`);
}

// ==========================================
// ✨ AI fill: subject, priority, points, tags and milestone for many bugs
// at once. Runs in batches, shows a preview, changes nothing until Apply.
// Uses the same window as "Reorganize with AI".
// ==========================================
let fillPlan = null; // { rows: [{ project, issue, fields, newSubject, on }], total, skipped }
const FIELD_LABELS = { subject: 'Subject', impact: 'Priority', points: 'Points', tags: 'Tags', milestone: 'Milestone' };

function openAiFill() {
    if (!aiAvailable()) return openSettings('ai');
    closeModals();
    fillPlan = null;
    $('organizeTitle').innerText = '✨ AI fill: check all bugs';
    const box = (id, label, checked) => `<label class="flex items-center gap-2"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} class="w-4 h-4"> ${label}</label>`;
    $('organizeBody').innerHTML = `
        <p>The AI reads your bugs and fills in <b>subject, priority, story points, tags and milestone</b>.
        New single-topic subjects are created when nothing fits. You'll see every change before anything is saved.</p>
        <fieldset class="space-y-1.5">
            <legend class="font-bold mb-1">Which bugs</legend>
            <label class="flex items-center gap-2"><input type="radio" name="fillScope" value="missing" checked class="w-4 h-4"> Only bugs with missing info</label>
            <label class="flex items-center gap-2"><input type="radio" name="fillScope" value="open" class="w-4 h-4"> All unfinished bugs</label>
            <label class="flex items-center gap-2"><input type="radio" name="fillScope" value="all" class="w-4 h-4"> All bugs</label>
            <label class="flex items-center gap-2"><input type="radio" name="fillScope" value="projects" class="w-4 h-4"> All bugs in all projects</label>
        </fieldset>
        <fieldset class="space-y-1.5">
            <legend class="font-bold mb-1">What to fill</legend>
            <div class="flex flex-wrap gap-x-4 gap-y-1.5">
                ${box('fillSubject', 'Subject', true)}${box('fillImpact', 'Priority', true)}${box('fillPoints', 'Story points', true)}${box('fillTags', 'Tags', true)}${box('fillMilestone', 'Milestone', true)}
            </div>
            ${box('fillOnlyEmpty', 'Only fill empty fields (keep everything already set)', true)}
            <p class="text-xs text-gray-500 dark:text-gray-400">With “only empty” on, priority is kept and subjects are only replaced when they're missing or not in your subject list.</p>
        </fieldset>
        <p class="text-xs text-gray-500 dark:text-gray-400">Bug descriptions are sent to Google Gemini.</p>`;
    organizeUI('', 'Start', 'startAiFill');
    openModal('organizeModal', 'organizeMain');
}

async function startAiFill() {
    const scope = (document.querySelector('[name="fillScope"]:checked') || {}).value || 'missing';
    const fields = FILL_FIELDS.filter(f => $('fill' + f[0].toUpperCase() + f.slice(1)).checked);
    const onlyEmpty = $('fillOnlyEmpty').checked;
    if (!fields.length) return toast('Pick at least one field to fill.');
    try {
        organizeUI('Reading bugs…', 'Working…', 'startAiFill', true);
        const subjects = subjectChoices();
        const milestones = [...new Set([...config.milestones, ...milestonesOf(issues)])];
        const source = scope === 'projects' ? await store().allIssues() : issues.map(issue => ({ project: currentProject, issue }));
        const picked = source.filter(({ issue }) => issue.desc.trim() &&
            (scope === 'missing' ? needsAiFill(issue, subjects, milestones) : scope === 'open' ? issue.status !== 'fixed' : true));
        if (!picked.length) { organizeUI('Nothing to do: every bug already has its info filled in.', 'Start', 'startAiFill'); return; }

        const ctx = { subjects, milestones, tags: tagsOf(source.map(x => x.issue)) };
        const items = picked.map((x, i) => ({ i, text: organizeText(x.issue) }));
        const results = new Map();
        for (let pass = 0; pass < 2 && results.size < items.length; pass++) {
            const batches = chunk(items.filter(it => !results.has(it.i)), FILL_BATCH);
            for (let b = 0; b < batches.length; b++) {
                organizeUI(`Asking the AI${pass ? ' again for skipped bugs' : ''}… batch ${b + 1} of ${batches.length} (${picked.length} bugs)`, 'Working…', 'startAiFill', true);
                const raw = (await callAiFunction('organize', { step: 'fill', items: batches[b], ...ctx }, 120000)) || (await askGemini(buildFillPrompt(batches[b], ctx)));
                parseFillResults(raw, batches[b].map(it => it.i), ctx).forEach((v, k) => results.set(k, v));
            }
        }

        fillPlan = {
            rows: picked.map((x, i) => {
                const s = results.get(i);
                if (!s) return null;
                const f = planFill(x.issue, s, { fields, onlyEmpty, subjects });
                return Object.keys(f).length ? { project: x.project, issue: x.issue, fields: f, newSubject: !!(f.subject && s.newSubject), on: true } : null;
            }).filter(Boolean),
            total: picked.length,
            skipped: picked.length - results.size
        };
        renderFillPreview();
    } catch (e) {
        console.error('AI fill error:', e);
        organizeUI(e.userMessage || e.message || 'Something went wrong.', 'Try again', 'startAiFill');
        if (e.noKey || e.badKey) { closeModals(); openSettings('ai'); toast(e.userMessage); }
    }
}

function renderFillPreview() {
    const p = fillPlan;
    const multi = new Set(p.rows.map(r => r.project)).size > 1;
    const on = p.rows.filter(r => r.on).length;
    const newSubjects = [...new Set(p.rows.filter(r => r.newSubject).map(r => r.fields.subject))];
    const show = (k, v) => k === 'impact' ? getImpactLabel(v) : k === 'points' ? `${v} pt${v === '1' ? '' : 's'}` : v;
    $('organizeBody').innerHTML = `
        ${newSubjects.length ? `<div><h3 class="font-bold mb-1.5">New subjects</h3><div class="flex flex-wrap gap-1.5">${newSubjects.map(s => `<span class="text-xs px-2.5 py-1 rounded-full bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200">+ ${esc(s)}</span>`).join('')}</div></div>` : ''}
        <div>
            <div class="flex items-center justify-between gap-2 mb-1.5">
                <h3 class="font-bold">Changes (${on} of ${p.rows.length} selected)</h3>
                <div class="text-xs flex gap-3">
                    <button type="button" data-action="fillAll" data-on="1" class="underline hover:text-blue-600">Select all</button>
                    <button type="button" data-action="fillAll" data-on="0" class="underline hover:text-blue-600">Select none</button>
                </div>
            </div>
            ${p.rows.length ? `<ul class="divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded">
                ${p.rows.map((r, k) => `
                <li class="flex gap-3 items-start p-2 ${r.on ? '' : 'opacity-50'}">
                    <input type="checkbox" data-action="fillToggle" data-idx="${k}" ${r.on ? 'checked' : ''} class="mt-1 w-4 h-4" aria-label="Apply AI changes to ${esc(r.issue.tag || 'new issue')}">
                    <div class="min-w-0 flex-1">
                        <div class="text-xs text-gray-500 dark:text-gray-400 font-mono">${esc(r.issue.tag || 'NEW')}${multi ? ` · ${esc(r.project)}` : ''}</div>
                        <div class="truncate" title="${esc(r.issue.desc)}">${esc(r.issue.desc)}</div>
                        <div class="text-xs mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                            ${Object.entries(r.fields).map(([k, v]) => {
                                const before = k === 'tags' ? r.issue.tags : r.issue[k];
                                return `<span><span class="text-gray-500 dark:text-gray-400">${FIELD_LABELS[k]}:</span> ${before ? `<span class="line-through opacity-60">${esc(show(k, before))}</span> → ` : ''}<b class="text-blue-700 dark:text-blue-300">${esc(show(k, v))}</b>${k === 'subject' && r.newSubject ? ' <span class="text-green-600 dark:text-green-400">(new)</span>' : ''}</span>`;
                            }).join('')}
                        </div>
                    </div>
                </li>`).join('')}
            </ul>` : '<p class="italic text-gray-500">The AI had nothing to add.</p>'}
            ${p.skipped ? `<p class="text-xs text-amber-600 dark:text-amber-400 mt-2">The AI skipped ${p.skipped} bug(s); they stay as they are.</p>` : ''}
        </div>`;
    organizeUI(`${p.total} bugs checked.`, `Apply to ${on} bug${on === 1 ? '' : 's'}`, 'applyAiFill');
}

async function applyAiFill() {
    const chosen = new Map(fillPlan.rows.filter(r => r.on).map(r => [r.issue.id, r]));
    if (!chosen.size) return toast('Nothing selected.');
    organizeUI('Saving…', 'Working…', 'applyAiFill', true);
    // New subjects join the team list
    const fresh = [...new Set([...chosen.values()].filter(r => r.newSubject).map(r => r.fields.subject))]
        .filter(s => !config.subjects.some(x => x.toLowerCase() === s.toLowerCase()));
    if (fresh.length) await store().saveConfig(sanitizeConfig({ ...config, subjects: [...config.subjects, ...fresh] }));
    const n = await store().rewriteIssues(i => (chosen.get(i.id) || {}).fields || null);
    fillPlan = null;
    closeModals();
    toast(`✨ AI filled in ${n} bug${n === 1 ? '' : 's'}.${fresh.length ? ` New subjects: ${fresh.join(', ')}.` : ''}`);
}

async function saveSettings() {
    const d = settingsDraft;
    const live = (list) => d[list].filter(r => !r.deleted && r.name.trim());
    const dupes = (rows) => rows.map(r => r.name.trim().toLowerCase()).filter((v, k, a) => a.indexOf(v) !== k);

    const subjects = live('subjects');
    if (!subjects.length) return toast('Keep at least one subject.');
    if (dupes(subjects).length) return toast(`Duplicate subject: “${dupes(subjects)[0]}”.`);
    if (dupes(live('milestones')).length) return toast(`Duplicate milestone: “${dupes(live('milestones'))[0]}”.`);

    // old value -> new value ('' = remove)
    const fallback = subjects[0].name.trim();
    const subjectMap = new Map();
    d.subjects.forEach(r => { if (r.orig && (r.deleted || !r.name.trim() || r.name.trim() !== r.orig)) subjectMap.set(r.orig, r.deleted || !r.name.trim() ? fallback : r.name.trim()); });
    const milestoneMap = new Map();
    d.milestones.forEach(r => { if (r.orig && (r.deleted || !r.name.trim() || r.name.trim() !== r.orig)) milestoneMap.set(r.orig, r.deleted ? '' : r.name.trim()); });
    const tagMap = new Map();
    d.tags.forEach(r => { if (r.orig && (r.deleted || !r.name.trim() || r.name.trim() !== r.orig)) tagMap.set(r.orig.toLowerCase(), r.deleted ? '' : r.name.trim().replace(/,/g, ' ')); });

    const removals = [...subjectMap].filter(([o]) => d.subjects.find(r => r.orig === o).deleted).length +
        [...milestoneMap.values()].filter(v => !v).length + [...tagMap.values()].filter(v => !v).length;
    if (removals && !confirm(`Deleted items will be removed from issues in ALL projects (deleted subjects move to “${fallback}”). Continue?`)) return;

    closeModals();
    await store().saveConfig(sanitizeConfig({ subjects: subjects.map(r => r.name), milestones: live('milestones').map(r => r.name) }));

    if (subjectMap.size || milestoneMap.size || tagMap.size) {
        const n = await store().rewriteIssues(i => {
            const out = {};
            if (subjectMap.has(i.subject)) out.subject = subjectMap.get(i.subject);
            if (i.milestone && milestoneMap.has(i.milestone)) out.milestone = milestoneMap.get(i.milestone);
            const before = parseTags(i.tags);
            const after = [];
            before.forEach(t => {
                const v = tagMap.has(t.toLowerCase()) ? tagMap.get(t.toLowerCase()) : t;
                if (v && !after.some(a => a.toLowerCase() === v.toLowerCase())) after.push(v);
            });
            if (after.join(', ') !== before.join(', ')) out.tags = clip(after.join(', '), LIMITS.tags);
            return Object.keys(out).length ? out : null;
        });
        toast(`Settings saved. ${n} issue${n === 1 ? '' : 's'} updated.`);
    } else {
        toast('Settings saved.');
    }
    settingsDraft = null;
}

// ==========================================
// Search, sort & filters
// State lives in `filters`; it is mirrored to the URL (shareable links)
// and to localStorage (remembered between visits).
// ==========================================
const FILTERS_KEY = 'btp_filters';

function loadFilters() {
    if (location.hash.length > 1) return queryToFilters(location.hash);
    try {
        const saved = JSON.parse(localStorage.getItem(FILTERS_KEY));
        if (saved) return normalizeFilters(saved);
        const oldSort = localStorage.getItem('sort'); // from the previous version
        if (SORTS.includes(oldSort)) return normalizeFilters({ sort: oldSort });
    } catch (e) { /* storage blocked or corrupt */ }
    return normalizeFilters({});
}
let filters = loadFilters();
let filterPanelOpen = false;

function setFilters(next) {
    filters = normalizeFilters(next);
    try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch (e) {}
    const qs = filtersToQuery(filters);
    history.replaceState(null, '', qs ? `#${qs}` : location.pathname + location.search);
    renderIssues();
}

window.addEventListener('hashchange', () => {
    filters = queryToFilters(location.hash);
    renderIssues();
});

function toggleFilterValue(key, value) {
    const cur = filters[key] || [];
    setFilters({ ...filters, [key]: cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value] });
}

// Options for each filter group, with counts across the whole project.
function filterGroups() {
    // With "Hide completed" on, counts only include bugs that still need work
    const base = countBase(issues, filters);
    const count = (pred) => base.filter(pred).length;
    const withSelected = (key, opts) => {
        // Keep selected values visible even if no issue has them any more
        const known = new Set(opts.map(o => o[0]));
        return opts.concat(filters[key].filter(v => !known.has(v)).map(v => [v, v]));
    };
    const assigneeOpts = [
        ...(isOnline() ? [['@me', 'Me']] : []),
        ['@none', 'Unassigned'],
        ...members.map(m => [m.email, m.name])
    ];
    const groups = [
        { key: 'status', label: 'Status', opts: STATUSES.map(s => [s, STATUS_LABELS[s]]), test: v => i => i.status === v },
        { key: 'impact', label: 'Priority', opts: ['1', '2', '3', '4'].map(v => [v, getImpactLabel(v)]), test: v => i => String(i.impact) === v },
        { key: 'subject', label: 'Subject', opts: [...new Set([...subjectChoices(), ...issues.map(i => i.subject)])].map(s => [s, s]), test: v => i => i.subject === v },
        { key: 'points', label: 'Story points', opts: [['none', 'None'], ...POINTS.map(p => [p, `${p} pt${p === '1' ? '' : 's'}`])], test: v => i => (i.points || 'none') === v },
        { key: 'milestone', label: 'Milestone', opts: milestonesOf(issues).map(m => [m, m]), test: v => i => i.milestone === v },
        { key: 'assignee', label: 'Assignee', opts: assigneeOpts, test: v => i => v === '@me' ? i.assignee === myEmail() : v === '@none' ? !i.assignee : i.assignee === v },
        { key: 'tags', label: 'Tags', opts: tagsOf(issues).map(t => [t, t]), test: v => i => parseTags(i.tags).some(t => t.toLowerCase() === v.toLowerCase()) }
    ];
    return groups.map(g => ({
        ...g,
        opts: withSelected(g.key, g.opts)
            .map(([value, label]) => ({ value, label, n: count(g.test(value)) }))
            // Hide options with nothing left to do (keep selected ones and the status group)
            .filter(o => !filters.hideDone || g.key === 'status' || o.n > 0 || filters[g.key].includes(o.value))
    }));
}

const chipCls = (on) => `text-xs px-2.5 py-1 rounded-full border transition ${on
    ? 'bg-blue-600 border-blue-600 text-white hover:bg-blue-500'
    : 'bg-gray-100 dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-blue-500'}`;

function renderFilterUI(shown) {
    // Remember focus so re-rendering doesn't lose the keyboard position
    const a = document.activeElement;
    const focusKey = a && a.dataset && a.dataset.action ? [a.dataset.action, a.dataset.key || '', a.dataset.value || '', a.dataset.view || ''] : null;

    // Search box and sort controls
    if ($('searchBar').value !== filters.q && document.activeElement !== $('searchBar')) $('searchBar').value = filters.q;
    $('sortBy').value = filters.sort;
    $('sortDirBtn').innerText = filters.rev ? '↑' : '↓';
    $('sortDirBtn').setAttribute('aria-pressed', String(filters.rev));
    $('sortDirBtn').classList.toggle('text-blue-600', filters.rev);

    // Filters button + badge
    const n = activeFilterCount({ ...filters, q: '' });
    $('filterCount').innerText = n;
    $('filterCount').classList.toggle('hidden', !n);
    $('filtersBtn').setAttribute('aria-expanded', String(filterPanelOpen));
    $('filterPanel').classList.toggle('hidden', !filterPanelOpen);

    // Quick views
    const activeView = matchingQuickView(filters);
    $('quickViews').innerHTML = Object.entries(QUICK_VIEWS)
        .filter(([k]) => k !== 'mine' || isOnline())
        .map(([k, v]) => `<button type="button" data-action="quickView" data-view="${k}" aria-pressed="${activeView === k}" class="${chipCls(activeView === k)}">${esc(v.label)}</button>`)
        .join('') +
        `<span class="mx-1 w-px self-stretch bg-gray-300 dark:bg-gray-600" aria-hidden="true"></span>
        <button type="button" data-action="toggleHideDone" role="switch" aria-checked="${filters.hideDone}"
            title="Leave fixed bugs out of the list and the filter counts"
            class="text-xs px-2.5 py-1 rounded-full border transition flex items-center gap-1.5 ${filters.hideDone
                ? 'bg-green-600 border-green-600 text-white hover:bg-green-500'
                : 'bg-gray-100 dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-green-500'}">
            <span aria-hidden="true">${filters.hideDone ? '✔' : '○'}</span> Hide completed
            <span class="opacity-75">(${issues.filter(i => i.status === 'fixed').length})</span>
        </button>`;

    // Panel: one group of toggle chips per filter
    if (filterPanelOpen) {
        $('filterPanel').innerHTML = filterGroups().map(g => `
            <fieldset>
                <legend class="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">${esc(g.label)}</legend>
                <div class="flex flex-wrap gap-1.5">
                    ${g.opts.length ? g.opts.map(o => {
                        const on = filters[g.key].includes(o.value);
                        return `<button type="button" data-action="toggleFilter" data-key="${g.key}" data-value="${esc(o.value)}" aria-pressed="${on}" class="${chipCls(on)}">${esc(o.label)} <span class="ml-0.5 px-1.5 rounded-full text-[10px] ${on ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700'}" aria-label="${o.n} issues">${o.n}</span></button>`;
                    }).join('') : '<span class="text-xs italic text-gray-400">None yet</span>'}
                </div>
            </fieldset>`).join('');
    }

    // Active filters row with counts
    const labelOf = (key, v) => {
        if (key === 'status') return STATUS_LABELS[v] || v;
        if (key === 'impact') return getImpactLabel(v);
        if (key === 'points') return v === 'none' ? 'None' : `${v} pt${v === '1' ? '' : 's'}`;
        if (key === 'assignee') return v === '@me' ? 'Me' : v === '@none' ? 'Unassigned' : memberName(v);
        return v;
    };
    const groupLabel = { status: 'Status', impact: 'Priority', subject: 'Subject', points: 'Points', milestone: 'Milestone', assignee: 'Assignee', tags: 'Tag' };
    const chips = [];
    if (filters.q.trim()) chips.push(`<button type="button" data-action="removeFilter" data-key="q" class="${chipCls(true)}" aria-label="Remove search ${esc(filters.q)}">Search: “${esc(filters.q)}” ✕</button>`);
    FILTER_GROUPS.forEach(k => filters[k].forEach(v => chips.push(
        `<button type="button" data-action="removeFilter" data-key="${k}" data-value="${esc(v)}" class="${chipCls(true)}" aria-label="Remove filter ${esc(groupLabel[k])} ${esc(labelOf(k, v))}">${esc(groupLabel[k])}: ${esc(labelOf(k, v))} ✕</button>`)));
    $('activeFilters').innerHTML = `
        <span class="font-medium">Showing ${shown} of ${issues.length}</span>
        ${chips.join('')}
        ${chips.length ? `<button type="button" data-action="clearFilters" class="underline hover:text-blue-600 ml-1">Clear all</button>` : ''}`;

    if (focusKey) {
        const [action, key, value, view] = focusKey;
        const sel = `[data-action="${action}"]` + (key ? `[data-key="${CSS.escape(key)}"]` : '') + (value ? `[data-value="${CSS.escape(value)}"]` : '') + (view ? `[data-view="${CSS.escape(view)}"]` : '');
        const el = document.querySelector(sel) || (action === 'removeFilter' ? document.querySelector('[data-action="removeFilter"], [data-action="clearFilters"]') || $('filtersBtn') : null);
        if (el && el !== document.activeElement) el.focus();
    }
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
                <button type="button" data-action="copyIssue" data-id="${sid}" class="${btnCls}" title="Copy this issue as text" aria-label="Copy ${label} as text">📋 Copy</button>
            </div>
        </article>
    `;
}

function renderIssues() {
    // Drop selections for issues that no longer exist (e.g. deleted by a teammate)
    const ids = new Set(issues.map(i => i.id));
    selectedIssues.forEach(id => { if (!ids.has(id)) selectedIssues.delete(id); });
    updateBulkActionBar();

    updateMilestoneList();
    updateSubjectOptions(); // new subjects from teammates or imports show up immediately
    const filtered = filterIssues(issues, filters, myEmail(), config.subjects);
    renderFilterUI(filtered.length);

    const empty = `<p class="text-gray-500 dark:text-gray-400 italic mt-4">${issues.length
        ? 'No issues match these filters. <button type="button" data-action="clearFilters" class="underline not-italic hover:text-blue-600">Clear all filters</button>'
        : 'No issues yet. Log one to get started!'}</p>`;
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
// The form lives in an overlay (#issueModal), opened by the + button or Edit.
let formDirty = false;
const touchedFields = new Set(); // fields set by hand (or by ✨) — auto-fill leaves these alone
const FORM_FIELD_IDS = { subject: 'subject', impact: 'impact', points: 'points', milestone: 'milestone', tags: 'tags' };
$('issueForm').addEventListener('input', (e) => { formDirty = true; markTouched(e.target); });
$('issueForm').addEventListener('change', (e) => { formDirty = true; markTouched(e.target); });
function markTouched(el) {
    const f = Object.keys(FORM_FIELD_IDS).find(k => FORM_FIELD_IDS[k] === (el && el.id));
    if (f) touchedFields.add(f);
}

function openIssueForm() {
    clearForm();
    updateSubjectOptions();
    openModal('issueModal', 'desc');
}

// Closing asks first if something was typed and not saved.
function closeIssueForm() {
    if (formDirty && !confirm('Discard your unsaved changes?')) return;
    clearForm();
    closeModals();
}

// Ctrl/Cmd+Enter saves from anywhere in the form
$('issueForm').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('issueForm').requestSubmit(); }
});

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
    if (!fields.desc.trim()) return $('desc').focus();
    // Only subjects the AI proposed in this form get added to the team list
    if (aiNewSubjects.has(fields.subject)) adoptSubject(fields.subject);
    aiNewSubjects.clear();
    const touched = new Set(touchedFields); // read before clearForm() resets it
    clearForm();
    closeModals();
    if (id) {
        store().update(id, fields);
    } else {
        const issue = sanitizeIssue({ ...fields, id: newId(), status: 'open', notes: [], createdBy: who(), createdAt: Date.now() });
        issue.history = withHistory([], who(), 'created');
        store().create(issue);
        if (autoFillEnabled() && aiAvailable()) autoFillNew(issue, touched);
    }
});

function editIssue(id) {
    const issue = issues.find(i => i.id === id);
    if (!issue) return;
    clearForm();
    updateSubjectOptions();
    $('editId').value = issue.id;
    $('desc').value = issue.desc;
    ensureSubjectOption(issue.subject);
    $('subject').value = issue.subject;
    $('impact').value = issue.impact;
    $('points').value = issue.points || '';
    $('milestone').value = issue.milestone || '';
    $('assignee').value = issue.assignee || '';
    $('tags').value = issue.tags || '';

    $('formTitle').innerText = `Editing ${issue.tag || 'Issue'}`;
    $('submitBtn').innerText = "Update Issue";
    openModal('issueModal', 'desc');
}

function clearForm() {
    $('issueForm').reset();
    $('editId').value = "";
    $('formTitle').innerText = "Log Issue";
    $('submitBtn').innerText = "Save Issue";
    aiNewSubjects.clear();
    touchedFields.clear();
    formDirty = false;
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
    $('newIssueFab').classList.toggle('bottom-24', selectedIssues.size > 0);
    $('newIssueFab').classList.toggle('bottom-5', selectedIssues.size === 0);
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

async function copyIssue(id) {
    const issue = issues.find(i => i.id === id);
    if (!issue) return;
    await copyText(issue.desc);
    toast('Description copied to clipboard.');
}

// What the AI may choose from: the team's subjects, milestones and tags.
function aiContext() {
    return {
        subjects: config.subjects,
        milestones: [...new Set([...config.milestones, ...milestonesOf(issues)])],
        tags: tagsOf(issues)
    };
}

// Fills every field the AI gave a valid answer for. Returns what changed.
function applySuggestion(s) {
    const changed = [];
    if (s.subject) {
        ensureSubjectOption(s.subject, s.newSubject);
        if (s.newSubject) aiNewSubjects.add(s.subject);
        $('subject').value = s.subject;
        changed.push(s.newSubject ? `new subject “${s.subject}”` : 'subject');
    }
    if (s.impact) { $('impact').value = s.impact; changed.push('priority'); }
    if (s.points) { $('points').value = s.points; changed.push('points'); }
    if (s.tags) {
        // Keep tags the user already typed, add the AI's
        const merged = [...parseTags($('tags').value)];
        s.tags.forEach(t => { if (!merged.some(m => m.toLowerCase() === t.toLowerCase())) merged.push(t); });
        $('tags').value = merged.join(', ');
        changed.push('tags');
    }
    if (s.milestone && !$('milestone').value.trim()) { $('milestone').value = s.milestone; changed.push('milestone'); }
    return changed;
}

// Preferred: the team's server function (key never reaches the browser).
// Fallback: a personal Gemini key stored in this browser.
async function callAiFunction(name, payload, timeout = 30000) {
    if (!isOnline() || !firebase.functions) return null;
    try {
        const res = await firebase.functions().httpsCallable(name, { timeout })(payload);
        return res.data;
    } catch (e) {
        if (['functions/permission-denied', 'functions/unauthenticated', 'functions/invalid-argument', 'functions/resource-exhausted'].includes(e.code)) throw e;
        console.info('Server categorize unavailable, falling back to personal key:', e.code);
        return null;
    }
}

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} };
const geminiKey = () => lsGet('gemini_api_key').trim();

// Errors the user can act on carry `.userMessage`
const aiError = (msg, extra = {}) => Object.assign(new Error(msg), { userMessage: msg }, extra);

async function geminiFetch(url, opts) {
    try { return await fetch(url, opts); }
    catch (e) { throw aiError('Could not reach Google Gemini. Check your internet connection, or whether an ad-blocker/privacy extension blocks generativelanguage.googleapis.com.'); }
}

// Models to try, best first: from Google's list for this key, then known fallbacks.
async function geminiModels(key, refresh) {
    const cached = lsGet('gemini_model');
    if (cached && !refresh) return [cached, ...FALLBACK_MODELS.filter(m => m !== cached)];
    const res = await geminiFetch(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
        const msg = ((await res.json().catch(() => ({}))).error || {}).message || '';
        throw aiError(/api key|API_KEY/i.test(msg) || res.status !== 400
            ? 'Gemini rejected the API key. Check it in ⚙️ Settings → AI (and that the "Generative Language API" is enabled for it).'
            : 'Gemini refused the request: ' + msg, { badKey: true });
    }
    const picked = res.ok ? pickGeminiModel((await res.json().catch(() => ({}))).models) : null;
    return picked ? [picked, ...FALLBACK_MODELS.filter(m => m !== picked)] : [...FALLBACK_MODELS];
}

// Sends a prompt to Gemini with the personal key and returns { json, model }.
async function geminiGenerate(promptText) {
    const key = geminiKey();
    if (!key) throw aiError('No Gemini API key yet. Add one in ⚙️ Settings → AI (free at aistudio.google.com/apikey).', { noKey: true });
    const body = JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    });
    let lastStatus = 0;
    for (let pass = 0; pass < 2; pass++) {
        const models = await geminiModels(key, pass > 0);
        for (const model of models) {
            const res = await geminiFetch(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body
            });
            lastStatus = res.status;
            if (res.status === 404) continue; // model not available: try the next one
            if (res.status === 401 || res.status === 403) throw aiError('Gemini rejected the API key. Check it in ⚙️ Settings → AI.', { badKey: true });
            if (res.status === 429) throw aiError('Gemini quota reached. Wait a minute and try again (free keys have a per-minute limit).');
            if (res.status === 400) {
                const msg = ((await res.json().catch(() => ({}))).error || {}).message || 'bad request';
                if (/api key/i.test(msg)) throw aiError('Gemini rejected the API key. Check it in ⚙️ Settings → AI.', { badKey: true });
                throw aiError('Gemini could not handle the request: ' + msg);
            }
            if (!res.ok) throw aiError(`Gemini request failed (status ${res.status}). Try again later.`);
            const data = await res.json();
            const cand = data.candidates && data.candidates[0];
            const text = cand && cand.content && cand.content.parts && cand.content.parts.map(p => p.text || '').join('');
            if (!text) throw aiError('Gemini returned no answer (it may have been blocked). Try rewording the description.');
            lsSet('gemini_model', model);
            try { return { json: parseAiJson(text), model }; }
            catch (e) { throw aiError('Gemini answered in an unexpected format. Try again.'); }
        }
        lsSet('gemini_model', '');
    }
    throw aiError(`None of the Gemini models are available for this key (last status ${lastStatus}).`);
}

async function askGemini(promptText) {
    return (await geminiGenerate(promptText)).json;
}

// True when an AI path exists: a personal key, or (signed in) the team's server function.
const aiAvailable = () => !!geminiKey() || isOnline();

// Shows an AI error; missing/bad keys open Settings at the AI section.
function showAiError(e) {
    console.error('AI error:', e);
    const msg = e.userMessage || e.message || 'AI request failed. Check the console.';
    // Don't cover an open form; offer a button instead
    if ((e.noKey || e.badKey) && !openModalEl()) openSettings('ai');
    else toast(msg, (e.noKey || e.badKey) && !openModalEl() ? 'Open Settings' : null, () => openSettings('ai'), 9000);
}

function renderAiSettings() {
    const key = geminiKey();
    $('aiKeyInput').value = '';
    $('aiKeyInput').placeholder = key ? `Saved key …${key.slice(-4)} (paste a new one to replace)` : 'Paste your Gemini API key';
    $('aiAutoFill').checked = autoFillEnabled();
    $('aiStatus').innerText = key ? 'A key is saved. Click “Test AI” to check it.' : (isOnline() ? 'No personal key. The team server function is used if it is deployed.' : 'No key yet.');
    $('aiStatus').className = 'text-xs text-gray-500 dark:text-gray-400';
}

function saveAiKey() {
    const v = $('aiKeyInput').value.trim();
    if (!v) return toast('Paste a key first.');
    if (/\s/.test(v) || v.length < 20) return toast('That does not look like a Gemini API key.');
    lsSet('gemini_api_key', v);
    lsSet('gemini_model', '');
    renderAiSettings();
    testAi();
}

const autoFillEnabled = () => lsGet('ai_autofill') !== 'off';
document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'aiAutoFill') lsSet('ai_autofill', e.target.checked ? '' : 'off');
});

// Fills the fields of a just-saved bug that the user didn't set themselves.
async function autoFillNew(issue, touched) {
    const project = currentProject;
    try {
        const ctx = aiContext();
        const raw = (await callAiFunction('categorize', { desc: issue.desc, ...ctx })) || (await askGemini(buildCategorizePrompt(issue.desc, ctx)));
        const sugg = parseAiSuggestion(raw, ctx);
        const fields = planFill(issue, sugg, { fields: FILL_FIELDS.filter(f => !touched.has(f)), onlyEmpty: false, subjects: subjectChoices() });
        // Milestone only when the user left it empty
        if (issue.milestone) delete fields.milestone;
        if (!Object.keys(fields).length || currentProject !== project) return;
        // In the cloud the new bug arrives via the live listener; wait for it briefly
        for (let k = 0; k < 20 && !issues.some(i => i.id === issue.id); k++) await new Promise(res => setTimeout(res, 250));
        if (!issues.some(i => i.id === issue.id)) return;
        if (fields.subject && sugg.newSubject) adoptSubject(fields.subject);
        store().update(issue.id, fields);
        const tag = (issues.find(i => i.id === issue.id) || {}).tag || 'New bug';
        toast(`✨ AI filled in ${tag}: ${Object.keys(fields).map(f => f === 'impact' ? 'priority' : f).join(', ')}.`);
    } catch (e) {
        if (e.noKey) return; // auto-fill is optional; ✨ and Settings explain how to set it up
        showAiError(e);
    }
}

async function testAi() {
    $('aiStatus').innerText = 'Testing…';
    $('aiStatus').className = 'text-xs text-gray-500 dark:text-gray-400';
    try {
        const viaFn = await callAiFunction('categorize', { desc: 'Game crashes when I open the shop', ...aiContext() });
        if (viaFn) { $('aiStatus').innerText = '✅ Working (team server function).'; $('aiStatus').className = 'text-xs text-green-600 dark:text-green-400'; return; }
        const { json, model } = await geminiGenerate('Reply with exactly this JSON: {"ok": true}');
        if (!json || json.ok !== true) throw aiError('Gemini answered, but not as expected.');
        $('aiStatus').innerText = `✅ Working. Model: ${model}`;
        $('aiStatus').className = 'text-xs text-green-600 dark:text-green-400';
    } catch (e) {
        console.error('AI test failed:', e);
        $('aiStatus').innerText = '❌ ' + (e.userMessage || e.message);
        $('aiStatus').className = 'text-xs text-red-600 dark:text-red-400';
    }
}

async function autoCategorize() {
    const desc = $('desc').value;
    if (!desc || desc.trim().length < 5) return toast("Please type a description first!");
    const btn = $('aiBtn');
    const originalText = btn.innerText;
    btn.innerText = "⏳ Thinking...";
    btn.disabled = true;
    try {
        const ctx = aiContext();
        const raw = (await callAiFunction('categorize', { desc, ...ctx })) || (await askGemini(buildCategorizePrompt(desc, ctx)));
        if (raw) {
            const changed = applySuggestion(parseAiSuggestion(raw, ctx));
            FILL_FIELDS.forEach(f => touchedFields.add(f));
            toast(changed.length ? `AI filled in: ${changed.join(', ')}. Check before saving.` : 'The AI had no usable suggestions.');
        }
    } catch (e) {
        showAiError(e);
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
    if (e.key === 'Escape') { e.preventDefault(); modal.id === 'issueModal' ? closeIssueForm() : closeModals(); return; }
    if (e.key !== 'Tab') return;
    const focusables = [...modal.querySelectorAll('button, input, textarea, select, [href]')].filter(el => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// Click on the dark backdrop closes the modal
document.querySelectorAll('[role="dialog"]').forEach(m => m.addEventListener('mousedown', (e) => {
    if (e.target !== m) return;
    if (m.id === 'issueModal') closeIssueForm(); else closeModals();
}));

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
        // Make the file's subjects and milestones selectable; drop combined
        // ("X & Y") subjects that the imported bugs no longer use.
        const used = new Set(imported.map(i => i.subject.toLowerCase()));
        const fresh = [...new Set(imported.map(i => i.subject))].filter(isSingleSubject);
        const kept = config.subjects.filter(s => isSingleSubject(s) || used.has(s.toLowerCase()));
        await store().saveConfig(sanitizeConfig({
            subjects: [...kept, ...fresh],
            milestones: [...config.milestones, ...milestonesOf(imported)]
        }));
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
    toggleTheme: () => toggleTheme(),
    openShareModal: () => openModal('shareModal'),
    openSettings: () => openSettings(),
    saveSettings: () => saveSettings(),
    settingsAdd: (el) => settingsAdd(el.dataset.list),
    settingsMove: (el) => settingsMove(el.dataset.list, Number(el.dataset.idx), Number(el.dataset.dir)),
    settingsDelete: (el) => settingsDelete(el.dataset.list, Number(el.dataset.idx)),
    openOrganize: () => openOrganize(),
    openAiFill: () => openAiFill(),
    startAiFill: () => startAiFill(),
    applyAiFill: () => applyAiFill(),
    fillAll: (el) => { fillPlan.rows.forEach(row => { row.on = el.dataset.on === '1'; }); renderFillPreview(); },
    fillToggle: (el) => { const row = fillPlan.rows[Number(el.dataset.idx)]; row.on = !row.on; renderFillPreview(); },
    startOrganize: () => startOrganize(),
    applyOrganize: () => applyOrganize(),
    organizeAll: (el) => { organizePlan.rows.forEach(row => { row.on = el.dataset.on === '1'; }); renderOrganizePreview(); },
    organizeToggle: (el) => { const row = organizePlan.rows[Number(el.dataset.idx)]; row.on = !row.on; renderOrganizePreview(); },
    closeModals: () => closeModals(),
    exportData: () => exportData(),
    pickImport: () => $('importFile').click(),
    toggleView: () => toggleView(),
    newIssue: () => openIssueForm(),
    closeIssueForm: () => closeIssueForm(),
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
    copyIssue: (el) => copyIssue(el.dataset.id),
    toggleFilters: () => { filterPanelOpen = !filterPanelOpen; try { localStorage.setItem('filterPanel', filterPanelOpen ? '1' : ''); } catch (e) {} renderIssues(); },
    toggleFilter: (el) => toggleFilterValue(el.dataset.key, el.dataset.value),
    removeFilter: (el) => el.dataset.key === 'q' ? setFilters({ ...filters, q: '' }) : toggleFilterValue(el.dataset.key, el.dataset.value),
    clearFilters: () => setFilters({ ...EMPTY_FILTERS, sort: filters.sort, rev: filters.rev, hideDone: filters.hideDone }),
    quickView: (el) => setFilters({ ...QUICK_VIEWS[el.dataset.view].filters, q: filters.q, hideDone: filters.hideDone }),
    toggleHideDone: () => setFilters({ ...filters, hideDone: !filters.hideDone }),
    toggleSortDir: () => setFilters({ ...filters, rev: !filters.rev }),
    forgetGeminiKey: () => { lsSet('gemini_api_key', ''); lsSet('gemini_model', ''); if ($('aiKeyInput')) renderAiSettings(); toast('Gemini key removed from this browser.'); },
    saveAiKey: () => saveAiKey(),
    testAi: () => testAi(),
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

$('sortBy').addEventListener('change', () => setFilters({ ...filters, sort: $('sortBy').value }));

let searchTimer = null;
$('searchBar').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setFilters({ ...filters, q: $('searchBar').value }), 150);
});
$('searchBar').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('searchBar').value) { e.preventDefault(); setFilters({ ...filters, q: '' }); }
});

// Shortcuts (unless you're typing somewhere): "/" focuses search, "n" opens a new issue
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || openModalEl()) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    if (e.key === '/') { e.preventDefault(); $('searchBar').focus(); }
    else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openIssueForm(); }
});

// --- Initial render ---
updateSubjectOptions();
try { filterPanelOpen = localStorage.getItem('filterPanel') === '1'; } catch (e) {}
try { if (localStorage.getItem('view') === 'kanban') toggleView(); } catch (e) {}
if (!auth) localStore.load();
else renderIssues();
