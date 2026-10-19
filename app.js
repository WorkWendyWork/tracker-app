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
let isKanban = false;
let selectedIssues = new Set();
let db = null;
let auth = null;
let projectModalMode = ''; // 'add' or 'edit'
let unsubIssues = null;
let unsubProjects = null;

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
const who = () => (auth && auth.currentUser && (auth.currentUser.displayName || auth.currentUser.email)) || 'Me';

function handleCloudError(e, label) {
    console.error(label, e);
    if (e && e.code === 'permission-denied') {
        setSyncStatus('⛔ No access', 'bad');
        alert("Your account is not on this tracker's allow-list. Ask the owner to add your email to firestore.rules.");
    } else {
        setSyncStatus('⚠️ Sync error', 'bad');
        alert('Could not save to the cloud: ' + (e && e.message ? e.message : e));
    }
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
    catch (e) { alert('Could not save in this browser (storage full or blocked). Use Export to keep a backup.'); }
}

const localStore = {
    load() {
        projects = local.projects.length ? [...local.projects] : ['main'];
        if (!projects.includes(currentProject)) currentProject = projects[0];
        issues = (local.issues[currentProject] || []).map(sanitizeIssue);
        updateProjectDropdown();
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
        if (it) Object.assign(it, fields, { updatedBy: who(), updatedAt: Date.now() });
        this._commit();
    },
    addNote(id, note) {
        const it = issues.find(i => i.id === id);
        if (it) it.notes.push(note);
        this._commit();
    },
    setStatus(ids, status) {
        issues.forEach(i => { if (ids.has(i.id)) Object.assign(i, { status, updatedBy: who(), updatedAt: Date.now() }); });
        this._commit();
    },
    remove(ids) {
        issues = issues.filter(i => !ids.has(i.id));
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
    }
};

// ==========================================
// Cloud storage (Firestore, one document per issue)
//   workspaces/{ws}/meta/projects            { list: [...] }
//   workspaces/{ws}/projects/{p}             { nextBug }
//   workspaces/{ws}/projects/{p}/issues/{id} { ...issue }
// ==========================================
const wsRef = () => db.collection('workspaces').doc(WORKSPACE);
const projectsRef = () => wsRef().collection('meta').doc('projects');
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

const cloudStore = {
    load() {
        subscribeProjects();
        subscribeIssues();
    },
    async create(issue) {
        const project = currentProject;
        try {
            await db.runTransaction(async tx => {
                const p = await tx.get(projectRef(project));
                const next = (p.exists && p.data().nextBug) || 1;
                tx.set(projectRef(project), { nextBug: next + 1 }, { merge: true });
                tx.set(issuesCol(project).doc(issue.id), { ...issue, tag: fmtBug(next) });
            });
        } catch (e) { handleCloudError(e, 'Create error:'); }
    },
    update(id, fields) {
        issuesCol(currentProject).doc(id).update({ ...fields, updatedBy: who(), updatedAt: Date.now() })
            .catch(e => handleCloudError(e, 'Update error:'));
    },
    addNote(id, note) {
        issuesCol(currentProject).doc(id).update({
            notes: firebase.firestore.FieldValue.arrayUnion(note), updatedBy: who(), updatedAt: Date.now()
        }).catch(e => handleCloudError(e, 'Note error:'));
    },
    setStatus(ids, status) {
        const col = issuesCol(currentProject);
        commitInBatches([...ids].map(id => b => b.update(col.doc(id), { status, updatedBy: who(), updatedAt: Date.now() })))
            .catch(e => handleCloudError(e, 'Bulk update error:'));
    },
    remove(ids) {
        const col = issuesCol(currentProject);
        commitInBatches([...ids].map(id => b => b.delete(col.doc(id))))
            .catch(e => handleCloudError(e, 'Delete error:'));
    },
    async replaceAll(arr) {
        const project = currentProject;
        const col = issuesCol(project);
        const keep = new Set(arr.map(i => i.id));
        const ops = [
            ...issues.filter(i => !keep.has(i.id)).map(i => b => b.delete(col.doc(i.id))),
            ...arr.map(i => b => b.set(col.doc(i.id), i)),
            b => b.set(projectRef(project), { nextBug: nextBugNumber(arr) }, { merge: true })
        ];
        try { await commitInBatches(ops); } catch (e) { handleCloudError(e, 'Import error:'); }
    },
    async addProject(name) {
        try {
            await db.runTransaction(async tx => {
                const snap = await tx.get(projectsRef());
                const list = (snap.exists && snap.data().list) || ['main'];
                if (!list.includes(name)) list.push(name);
                tx.set(projectsRef(), { list });
            });
            currentProject = name;
            subscribeIssues();
        } catch (e) { handleCloudError(e, 'Project error:'); }
    },
    // Copy first, switch the list, then delete — so a failure never loses issues.
    async renameProject(oldName, newName) {
        try {
            setSyncStatus('⏳ Renaming...', 'warn');
            const [docs, meta] = await Promise.all([issuesCol(oldName).get(), projectRef(oldName).get()]);
            await commitInBatches([
                ...docs.docs.map(d => b => b.set(issuesCol(newName).doc(d.id), d.data())),
                b => b.set(projectRef(newName), meta.exists ? meta.data() : { nextBug: 1 })
            ]);
            await db.runTransaction(async tx => {
                const snap = await tx.get(projectsRef());
                const list = ((snap.exists && snap.data().list) || ['main']).map(p => p === oldName ? newName : p);
                if (!list.includes(newName)) list.push(newName);
                tx.set(projectsRef(), { list });
            });
            currentProject = newName;
            subscribeIssues();
            await commitInBatches([
                ...docs.docs.map(d => b => b.delete(d.ref)),
                b => b.delete(projectRef(oldName))
            ]);
        } catch (e) { handleCloudError(e, 'Rename error:'); }
    }
};

const store = () => isOnline() ? cloudStore : localStore;

// Older versions kept a whole project in one document (data/{project}).
// Move that into per-issue documents once, the first time it is opened.
async function migrateLegacy(project) {
    const legacyRef = wsRef().collection('data').doc(project);
    const counterRef = wsRef().collection('counters').doc(project);
    const snap = await legacyRef.get();
    if (!snap.exists) return;
    const old = (snap.data().issues || []).map(sanitizeIssue);
    let next = nextBugNumber(old);
    old.forEach(i => { if (!/^BUG-\d+$/.test(i.tag)) i.tag = fmtBug(next++); });
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
    try { await migrateLegacy(project); } catch (e) { console.warn('Legacy migration skipped:', e); }
    if (project !== currentProject || !isOnline()) return;
    unsubIssues = issuesCol(project).onSnapshot({ includeMetadataChanges: true }, snap => {
        if (project !== currentProject) return;
        issues = snap.docs.map(d => sanitizeIssue({ ...d.data(), id: d.id }));
        if (snap.metadata.hasPendingWrites) setSyncStatus('⏳ Saving...', 'warn');
        else if (snap.metadata.fromCache) setSyncStatus('📴 Offline – will sync', 'warn');
        else setSyncStatus('☁️ Synced', 'ok');
        renderIssues();
    }, e => handleCloudError(e, 'Issue sync error:'));
}

function subscribeProjects() {
    if (unsubProjects) unsubProjects();
    unsubProjects = projectsRef().onSnapshot(doc => {
        const list = doc.exists && doc.data().list;
        projects = (list && list.length) ? list : ['main'];
        if (!projects.includes(currentProject)) {
            currentProject = projects[0];
            subscribeIssues();
        }
        updateProjectDropdown();
    }, e => handleCloudError(e, 'Project sync error:'));
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
                const snap = await tx.get(projectsRef());
                const list = (snap.exists && snap.data().list) || ['main'];
                if (!list.includes(project)) list.push(project);
                tx.set(projectsRef(), { list });
            });
            for (const raw of arr) {
                const issue = sanitizeIssue(raw);
                await db.runTransaction(async tx => {
                    const p = await tx.get(projectRef(project));
                    const next = (p.exists && p.data().nextBug) || 1;
                    tx.set(projectRef(project), { nextBug: next + 1 }, { merge: true });
                    tx.set(issuesCol(project).doc(issue.id), { ...issue, tag: fmtBug(next), createdBy: issue.createdBy || who() });
                });
            }
            delete local.issues[project];
            writeLocal();
        }
        alert(`Uploaded ${total} issue(s) to the cloud.`);
    } catch (e) { handleCloudError(e, 'Upload error:'); }
}

// --- Firebase Initialization ---
try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    // Cache cloud data on this device so edits made offline sync later.
    db.enablePersistence({ synchronizeTabs: true }).catch(e => console.info('Offline cache unavailable:', e.code));
    auth = firebase.auth();

    auth.onAuthStateChanged(async user => {
        const btn = $('authBtn');
        if (unsubIssues) unsubIssues();
        if (unsubProjects) unsubProjects();
        unsubIssues = unsubProjects = null;
        selectedIssues.clear();
        updateBulkActionBar();
        if (user) {
            btn.innerText = '🚪 Sign out';
            btn.title = `Signed in as ${user.email || 'user'}`;
            setSyncStatus('⏳ Connecting...', 'warn');
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
    if (!auth) return alert('Firebase is not configured.');
    if (auth.currentUser) return auth.signOut();
    auth.signInWithPopup(new firebase.auth.GoogleAuthProvider())
        .catch(e => {
            if (e.code === 'auth/popup-closed-by-user') return;
            console.error('Sign-in error:', e);
            alert('Sign-in failed: ' + e.message);
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

$('projectSelect').addEventListener('change', (e) => {
    currentProject = e.target.value;
    selectedIssues.clear();
    updateBulkActionBar();
    store().load();
});

function updateMilestoneFilter() {
    const filter = $('filterMilestone');
    const currentVal = filter.value;
    const milestones = milestonesOf(issues);
    filter.innerHTML = '<option value="all">All Milestones</option>' +
        milestones.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    filter.value = milestones.includes(currentVal) ? currentVal : 'all';
    $('milestoneList').innerHTML = milestones.map(m => `<option value="${esc(m)}"></option>`).join('');
}

function buildIssueCardHTML(issue) {
    const isSelected = selectedIssues.has(issue.id);
    const statusOpacity = issue.status === 'fixed' ? 'opacity-60 grayscale hover:grayscale-0' : '';
    const borderCol = isSelected ? 'border-blue-500 ring-2 ring-blue-500' : 'border-gray-200 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500';
    const htmlParsed = DOMPurify.sanitize(marked.parse(issue.desc));
    const sid = esc(issue.id);

    const tagsHtml = parseTags(issue.tags).map(t => `<span class="text-[10px] bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-1.5 py-0.5 rounded">${esc(t)}</span>`).join('');

    const notesHtml = issue.notes.length ? `<div class="mt-3 pt-2 border-t border-gray-200 dark:border-gray-700 space-y-1">
            ${issue.notes.map(n => `<div class="text-xs text-gray-600 dark:text-gray-400"><span class="font-bold">${esc(n.date)}${n.author ? ' · ' + esc(n.author) : ''}:</span> ${esc(n.text)}</div>`).join('')}
        </div>` : '';

    const meta = [
        issue.createdBy && `Logged by ${esc(issue.createdBy)}`,
        issue.updatedBy && issue.updatedAt && `updated by ${esc(issue.updatedBy)} ${esc(formatDate(issue.updatedAt))}`
    ].filter(Boolean).join(', ');

    return `
        <div id="${sid}" class="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border ${borderCol} transition-all relative group ${statusOpacity}" draggable="true" ondragstart="dragStart(event)">
            <div class="absolute top-2 right-2 ${isSelected ? 'block' : 'hidden group-hover:block'}">
                <input type="checkbox" class="w-4 h-4 cursor-pointer" ${isSelected ? 'checked' : ''} onclick="toggleSelection('${sid}', event)">
            </div>

            <div class="flex flex-wrap gap-2 items-center mb-2 pr-6">
                <span class="text-[10px] font-mono font-bold text-gray-500 dark:text-gray-400">${esc(issue.tag || '…')}</span>
                <span class="text-[10px] uppercase font-bold px-2 py-0.5 rounded border ${getImpactColor(issue.impact)}">${getImpactLabel(issue.impact)}</span>
                ${issue.points ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-200 border border-yellow-300 dark:border-yellow-800" title="Story Points">⭐ ${esc(issue.points)}</span>` : ''}
                ${issue.milestone ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-200 border border-purple-300 dark:border-purple-800" title="Milestone">🎯 ${esc(issue.milestone)}</span>` : ''}
                <span class="text-xs text-blue-700 dark:text-blue-300 font-mono bg-blue-100 dark:bg-blue-900/30 px-2 py-0.5 rounded">${esc(issue.subject)}</span>
            </div>

            <div class="markdown-prose text-sm text-gray-800 dark:text-gray-200 break-words mb-3">${htmlParsed}</div>

            ${tagsHtml ? `<div class="flex flex-wrap gap-1 mb-2">${tagsHtml}</div>` : ''}
            ${notesHtml}
            ${meta ? `<div class="mt-2 text-[10px] text-gray-400 dark:text-gray-500">${meta}</div>` : ''}

            <div class="mt-3 flex flex-wrap gap-2 pt-3 border-t border-gray-100 dark:border-gray-700">
                <select onchange="updateStatus('${sid}', this.value)" class="text-xs bg-gray-100 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 outline-none text-gray-800 dark:text-white">
                    <option value="open" ${issue.status === 'open' ? 'selected' : ''}>Open</option>
                    <option value="in_progress" ${issue.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
                    <option value="fixed" ${issue.status === 'fixed' ? 'selected' : ''}>Fixed</option>
                </select>
                <button onclick="editIssue('${sid}')" class="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white transition">Edit</button>
                <button onclick="addNote('${sid}')" class="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white transition">Note</button>
                <button onclick="askClaude('${sid}')" class="text-xs px-2 py-1 rounded bg-[#F0E6D2] text-[#8C7A5B] hover:bg-[#E6D5B8] dark:bg-[#3D382D] dark:text-[#D4C5A9] dark:hover:bg-[#4D4638] font-medium transition" title="Copy prompt and open Claude">🤖 Claude</button>
            </div>
        </div>
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
        query: $('searchBar').value
    });

    const columns = { open: [], in_progress: [], fixed: [] };
    filtered.forEach(i => columns[i.status].push(buildIssueCardHTML(i)));

    $('gridView').innerHTML = filtered.length
        ? filtered.map(buildIssueCardHTML).join('')
        : `<p class="text-gray-500 dark:text-gray-400 italic mt-4">${issues.length ? 'No issues match current filters.' : 'No issues yet. Log one on the left!'}</p>`;
    $('kb-open').innerHTML = columns.open.join('');
    $('kb-in_progress').innerHTML = columns.in_progress.join('');
    $('kb-fixed').innerHTML = columns.fixed.join('');
    $('kb-open-count').innerText = columns.open.length;
    $('kb-prog-count').innerText = columns.in_progress.length;
    $('kb-fixed-count').innerText = columns.fixed.length;

    $('progressBar').style.width = `${progressPct(issues)}%`;
}

// ==========================================
// Core Interactions
// ==========================================
$('issueForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('editId').value;
    const fields = {
        desc: $('desc').value,
        subject: $('subject').value,
        impact: $('impact').value,
        points: $('points').value,
        milestone: $('milestone').value.trim(),
        tags: $('tags').value
    };
    clearForm();
    if (id) {
        store().update(id, fields);
    } else {
        const now = Date.now();
        store().create(sanitizeIssue({ ...fields, id: newId(), status: 'open', notes: [], createdBy: who(), createdAt: now, updatedAt: 0 }));
    }
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
    $('tags').value = issue.tags || '';

    $('formTitle').innerText = `Editing ${issue.tag || 'Issue'}`;
    $('submitBtn').innerText = "Update Issue";
    $('cancelEditBtn').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearForm() {
    $('issueForm').reset();
    $('editId').value = "";
    $('formTitle').innerText = "Log Issue";
    $('submitBtn').innerText = "Save Issue";
    $('cancelEditBtn').classList.add('hidden');
}

function updateStatus(id, newStatus) {
    if (!STATUSES.includes(newStatus) || !issues.some(i => i.id === id)) return;
    store().setStatus(new Set([id]), newStatus);
}

function addNote(id) {
    const text = prompt("Add a progress note:");
    if (!text) return;
    store().addNote(id, { id: newId(), text, date: formatDate(Date.now()), author: isOnline() ? who() : '' });
}

function toggleView() {
    isKanban = !isKanban;
    $('gridView').classList.toggle('hidden', isKanban);
    $('kanbanView').classList.toggle('hidden', !isKanban);
    $('toggleViewBtn').innerText = isKanban ? "📄 Grid" : "📋 Kanban";
    try { localStorage.setItem('view', isKanban ? 'kanban' : 'grid'); } catch (e) {}
}

function toggleTheme() {
    const dark = document.documentElement.classList.toggle('dark');
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
}

function insertImageMarkdown() {
    const url = prompt("Paste Image URL:");
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) return alert("Please paste a link starting with http:// or https://");
    const ta = $('desc');
    ta.value += `\n![Image](${url.replace(/[()\s]/g, encodeURIComponent)})\n`;
    ta.focus();
}

// --- Bulk Actions ---
function toggleSelection(id, e) {
    e.stopPropagation();
    if (selectedIssues.has(id)) selectedIssues.delete(id);
    else selectedIssues.add(id);
    renderIssues();
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
    if (!confirm(`Delete ${selectedIssues.size} issues permanently?`)) return;
    const ids = new Set(selectedIssues);
    clearSelection();
    store().remove(ids);
}

// --- Drag and Drop (Kanban) ---
function dragStart(e) { e.dataTransfer.setData('text/plain', e.currentTarget.id); }
function allowDrop(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function dragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function drop(e, status) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    updateStatus(e.dataTransfer.getData('text/plain'), status);
}

// ==========================================
// Integrations
// ==========================================
async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try { await navigator.clipboard.writeText(text); return; } catch (e) { /* fall back */ }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
}

async function askClaude(id) {
    const issue = issues.find(i => i.id === id);
    if (!issue) return;
    const promptStr = `I am a game developer working on a Unity idle/incremental game. I need help fixing this issue from my backlog:\n\n**Subject:** ${issue.subject}\n**Priority:** ${getImpactLabel(issue.impact)}\n**Issue Description:**\n${issue.desc}\n\nCan you analyze this issue, suggest potential architectural or code solutions in Unity C#, and give me a step-by-step approach to fixing it?`;
    await copyText(promptStr);
    alert("Prompt copied! Opening Claude...");
    window.open('https://claude.ai/new', '_blank', 'noopener');
}

async function autoCategorize() {
    const desc = $('desc').value;
    if (!desc || desc.length < 5) return alert("Please type a description first!");

    let userApiKey = null;
    try { userApiKey = localStorage.getItem('gemini_api_key'); } catch (e) {}
    if (!userApiKey) {
        userApiKey = prompt("Enter your Gemini API Key to enable AI categorization.\n(It is stored only in this browser.)");
        if (!userApiKey) return;
        try { localStorage.setItem('gemini_api_key', userApiKey); } catch (e) {}
    }

    const promptText = `Analyze this bug report for a video game: "${desc}". \nReturn ONLY a JSON object with two keys: "subject" (choose from: ${SUBJECTS.map(s => `"${s}"`).join(', ')}) and "impact" (choose a number 1 to 4, where 1 is Critical, 2 is High, 3 is Medium, 4 is Low). No markdown or extra text.`;

    const btn = $('aiBtn');
    const originalText = btn.innerText;
    btn.innerText = "⏳ Thinking...";
    btn.disabled = true;

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': userApiKey },
            body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] })
        });

        if (!response.ok) {
            if (response.status === 400 || response.status === 403) {
                try { localStorage.removeItem('gemini_api_key'); } catch (e) {}
                throw new Error("Invalid API Key. Your saved key has been cleared. Please try again.");
            }
            throw new Error("API request failed with status " + response.status);
        }

        const data = await response.json();
        const result = parseAiJson(data.candidates[0].content.parts[0].text);
        if (SUBJECTS.includes(result.subject)) $('subject').value = result.subject;
        if (['1', '2', '3', '4'].includes(String(result.impact))) $('impact').value = String(result.impact);
    } catch (e) {
        console.error("AI Error:", e);
        alert(e.message || "AI generation failed. Check console.");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

// ==========================================
// Modals & Projects
// ==========================================
function showModal(id, show) {
    $(id).classList.toggle('hidden', !show);
    $(id).classList.toggle('flex', show);
}

function openProjectModal(mode) {
    projectModalMode = mode;
    $('projectModalTitle').innerText = mode === 'add' ? 'Create New Project' : 'Rename Project';
    $('projectModalInput').value = mode === 'edit' ? currentProject : '';
    showModal('projectModal', true);
    $('projectModalInput').focus();
}

function closeProjectModal() { showModal('projectModal', false); }

async function confirmProjectModal() {
    const input = normalizeProjectName($('projectModalInput').value);
    if (!input) return alert("Use letters, numbers, spaces, - or _.");
    const oldName = currentProject;
    if (input !== oldName && projects.includes(input)) return alert("A project with that name already exists.");
    closeProjectModal();
    if (projectModalMode === 'add' && input !== oldName) {
        await store().addProject(input);
    } else if (projectModalMode === 'edit' && input !== oldName) {
        await store().renameProject(oldName, input);
    }
}

$('projectModalInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmProjectModal();
    if (e.key === 'Escape') closeProjectModal();
});

function openShareModal() { showModal('shareModal', true); }
function closeShareModal() { showModal('shareModal', false); }

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

function importData(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        let imported;
        try { imported = validateImport(JSON.parse(e.target.result)); }
        catch (err) { return alert("Invalid JSON file."); }
        if (!imported) return alert("File is not a valid tracker backup.");
        if (!confirm(`Replace all ${issues.length} issues in "${currentProject}" with ${imported.length} imported issues?`)) return;
        let next = nextBugNumber(imported);
        imported.forEach(i => { if (!i.tag) i.tag = fmtBug(next++); });
        await store().replaceAll(imported);
        alert("Data restored successfully!");
    };
    reader.readAsText(file);
}

// --- Filters ---
['filterStatus', 'filterImpact', 'filterMilestone'].forEach(id => $(id).addEventListener('change', renderIssues));
$('searchBar').addEventListener('input', renderIssues);

// --- Initial render ---
try { if (localStorage.getItem('view') === 'kanban') toggleView(); } catch (e) {}
if (!auth) localStore.load();
else renderIssues();
