// Pure helpers shared by the app (browser globals) and the tests (Node require).
// Nothing in here touches the DOM or Firebase.

const STATUSES = ['open', 'in_progress', 'fixed'];
const STATUS_LABELS = { open: 'Open', in_progress: 'In Progress', fixed: 'Fixed' };
const SUBJECTS = ['Gameplay & Balance', 'UI & Navigation', 'Visuals & Juice', 'Technical / Architecture'];
const POINTS = ['1', '2', '3', '5', '8'];

// Keep in sync with validIssue() in firestore.rules
const LIMITS = { desc: 20000, milestone: 60, tags: 300, note: 2000, notes: 200, history: 50, text: 200 };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMPACT_LABELS = { '1': 'Critical', '2': 'High', '3': 'Medium', '4': 'Low' };
const IMPACT_COLORS = {
    '1': 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200 border-red-300 dark:border-red-800',
    '2': 'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-200 border-orange-300 dark:border-orange-800',
    '3': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-200 border-yellow-300 dark:border-yellow-800',
    '4': 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200 border-green-300 dark:border-green-800'
};
const getImpactLabel = (val) => IMPACT_LABELS[String(val)] || 'Unknown';
const getImpactColor = (val) => IMPACT_COLORS[String(val)] || IMPACT_COLORS['4'];

const clip = (v, n) => String(v ?? '').slice(0, n);

// Escape user text before putting it into HTML
function esc(v) {
    return String(v ?? '').replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]);
}

const bugNum = (issue) => parseInt(String((issue && issue.tag) || '').replace('BUG-', ''), 10) || 0;
const fmtBug = (n) => 'BUG-' + String(n).padStart(4, '0');
const nextBugNumber = (issues) => issues.reduce((m, i) => Math.max(m, bugNum(i)), 0) + 1;

function newId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

const parseTags = (tags) => String(tags || '').split(',').map(t => t.trim()).filter(Boolean);

// Project names become Firestore document ids, so keep them simple.
const normalizeProjectName = (name) => String(name || '').trim().replace(/[^a-zA-Z0-9-_ ]/g, '').slice(0, 60);

// assignee: 'all' | 'mine' | 'none'; `me` is the signed-in email
const SORTS = ['priority', 'subject', 'number', 'updated'];

// Unnumbered (NEW) issues sort after numbered ones
const byNumber = (a, b) => (bugNum(a) || Number.MAX_SAFE_INTEGER) - (bugNum(b) || Number.MAX_SAFE_INTEGER);
const byPriority = (a, b) => Number(a.impact) - Number(b.impact);
const bySubject = (a, b) => {
    const ia = SUBJECTS.indexOf(a.subject), ib = SUBJECTS.indexOf(b.subject);
    return (ia < 0 ? SUBJECTS.length : ia) - (ib < 0 ? SUBJECTS.length : ib);
};
const byUpdated = (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);

const COMPARATORS = {
    priority: (a, b) => byPriority(a, b) || byNumber(a, b),
    subject: (a, b) => bySubject(a, b) || byPriority(a, b) || byNumber(a, b),
    number: byNumber,
    updated: (a, b) => byUpdated(a, b) || byNumber(a, b)
};

function filterIssues(issues, { status = 'all', impact = 'all', milestone = 'all', query = '', assignee = 'all', me = '', sort = 'priority' } = {}) {
    const q = String(query).toLowerCase();
    return issues
        .filter(i => status === 'all' || i.status === status)
        .filter(i => impact === 'all' || String(i.impact) === String(impact))
        .filter(i => milestone === 'all' || i.milestone === milestone)
        .filter(i => assignee === 'all' || (assignee === 'none' ? !i.assignee : (!!me && i.assignee === me)))
        .filter(i => !q || [i.desc, i.subject, i.tag, i.tags, i.milestone, i.assignee].some(f => String(f || '').toLowerCase().includes(q)))
        .sort(COMPARATORS[sort] || COMPARATORS.priority);
}

function progressPct(issues) {
    if (!issues.length) return 0;
    return Math.round(issues.filter(i => i.status === 'fixed').length / issues.length * 100);
}

const milestonesOf = (issues) => [...new Set(issues.map(i => i.milestone).filter(Boolean))].sort();

function formatDate(ms) {
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Fills in defaults and drops anything unexpected, so imported or legacy
// data can never break rendering or smuggle extra fields into the database.
// The output must always pass validIssue() in firestore.rules.
function sanitizeIssue(raw) {
    const i = raw && typeof raw === 'object' ? raw : {};
    return {
        id: typeof i.id === 'string' && /^[\w-]{1,64}$/.test(i.id) ? i.id : newId(),
        tag: typeof i.tag === 'string' && /^BUG-\d{1,8}$/.test(i.tag) ? i.tag : '',
        desc: clip(i.desc, LIMITS.desc),
        subject: SUBJECTS.includes(i.subject) ? i.subject : SUBJECTS[0],
        impact: ['1', '2', '3', '4'].includes(String(i.impact)) ? String(i.impact) : '3',
        points: POINTS.includes(String(i.points)) ? String(i.points) : '',
        milestone: clip(i.milestone, LIMITS.milestone),
        tags: clip(i.tags, LIMITS.tags),
        assignee: clip(i.assignee, LIMITS.text),
        status: STATUSES.includes(i.status) ? i.status : 'open',
        notes: Array.isArray(i.notes) ? i.notes.filter(n => n && typeof n === 'object').slice(-LIMITS.notes).map(n => ({
            id: typeof n.id === 'string' && n.id ? clip(n.id, 64) : newId(),
            text: clip(n.text, LIMITS.note),
            date: clip(n.date, 40),
            author: clip(n.author, LIMITS.text),
            edited: n.edited === true
        })) : [],
        history: Array.isArray(i.history) ? i.history.filter(h => h && typeof h === 'object').slice(-LIMITS.history).map(h => ({
            at: Number(h.at) || 0,
            by: clip(h.by, LIMITS.text),
            text: clip(h.text, LIMITS.text)
        })) : [],
        createdBy: clip(i.createdBy, LIMITS.text),
        createdByUid: clip(i.createdByUid, 128),
        createdAt: Number(i.createdAt) || 0,
        updatedBy: clip(i.updatedBy, LIMITS.text),
        updatedAt: Number(i.updatedAt) || 0
    };
}

// Returns sanitized issues, or null when the file is not a tracker backup.
function validateImport(data) {
    if (!Array.isArray(data)) return null;
    if (!data.every(i => i && typeof i === 'object' && typeof i.desc === 'string')) return null;
    const seen = new Set();
    const tags = new Set();
    return data.map(sanitizeIssue).map(i => {
        if (seen.has(i.id)) i.id = newId();
        seen.add(i.id);
        if (tags.has(i.tag)) i.tag = ''; // duplicate numbers get renumbered
        if (i.tag) tags.add(i.tag);
        return i;
    });
}

// Human-readable summary of what an edit changed, for the issue history.
function describeChanges(before, after) {
    const out = [];
    if (after.status !== undefined && after.status !== before.status) out.push(`status → ${STATUS_LABELS[after.status] || after.status}`);
    if (after.impact !== undefined && String(after.impact) !== String(before.impact)) out.push(`priority → ${getImpactLabel(after.impact)}`);
    if (after.assignee !== undefined && after.assignee !== (before.assignee || '')) out.push(after.assignee ? `assigned → ${after.assignee}` : 'unassigned');
    if (after.subject !== undefined && after.subject !== before.subject) out.push(`subject → ${after.subject}`);
    if (after.milestone !== undefined && after.milestone !== (before.milestone || '')) out.push(`milestone → ${after.milestone || 'none'}`);
    if (after.points !== undefined && String(after.points) !== String(before.points || '')) out.push(`points → ${after.points || 'none'}`);
    if (after.tags !== undefined && after.tags !== (before.tags || '')) out.push('tags edited');
    if (after.desc !== undefined && after.desc !== before.desc) out.push('description edited');
    return clip(out.join(', '), LIMITS.text);
}

// Returns a new history array with the entry appended (capped).
function withHistory(history, by, text, at = Date.now()) {
    if (!text) return history || [];
    return [...(history || []), { at, by: clip(by, LIMITS.text), text: clip(text, LIMITS.text) }].slice(-LIMITS.history);
}

// Plain-text version of an issue for the Copy button. `nameOf` maps an assignee email to a display name.
function formatIssueText(issue, nameOf = (e) => e) {
    const details = [
        `Status: ${STATUS_LABELS[issue.status] || issue.status}`,
        issue.milestone && `Milestone: ${issue.milestone}`,
        issue.points && `Points: ${issue.points}`,
        issue.assignee && `Assignee: ${nameOf(issue.assignee)}`,
        parseTags(issue.tags).length && `Tags: ${parseTags(issue.tags).join(', ')}`
    ].filter(Boolean).join(' | ');
    const lines = [
        `${issue.tag || 'NEW'} · ${getImpactLabel(issue.impact)} · ${issue.subject}`,
        details,
        '',
        String(issue.desc || '').trim()
    ];
    if (issue.notes && issue.notes.length) {
        lines.push('', 'Notes:', ...issue.notes.map(n => `- ${n.date}${n.author ? ' (' + n.author + ')' : ''}: ${n.text}`));
    }
    return lines.join('\n');
}

function buildCategorizePrompt(desc) {
    return `Analyze this bug report for a video game: "${clip(desc, 4000)}". \nReturn ONLY a JSON object with two keys: "subject" (choose from: ${SUBJECTS.map(s => `"${s}"`).join(', ')}) and "impact" (choose a number 1 to 4, where 1 is Critical, 2 is High, 3 is Medium, 4 is Low). No markdown or extra text.`;
}

// Returns an error message, or '' if the file is an acceptable screenshot.
function checkImageFile(file) {
    if (!file) return 'No file selected.';
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return 'Only PNG, JPEG, GIF or WebP images are allowed.';
    if (file.size > MAX_IMAGE_BYTES) return 'Images must be 5 MB or smaller.';
    return '';
}

// Gemini sometimes wraps its JSON in a ``` fence.
function parseAiJson(text) {
    const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(cleaned);
}

function chunk(arr, size) {
    const out = [];
    for (let k = 0; k < arr.length; k += size) out.push(arr.slice(k, k + size));
    return out;
}

if (typeof module !== 'undefined') {
    module.exports = {
        STATUSES, STATUS_LABELS, SUBJECTS, POINTS, SORTS, LIMITS, MAX_IMAGE_BYTES,
        getImpactLabel, getImpactColor, esc, bugNum, fmtBug, nextBugNumber, newId,
        parseTags, normalizeProjectName, filterIssues, progressPct, milestonesOf, formatDate,
        sanitizeIssue, validateImport, describeChanges, withHistory,
        formatIssueText, buildCategorizePrompt, checkImageFile, parseAiJson, chunk
    };
}
