// Pure helpers shared by the app (browser globals) and the tests (Node require).
// Nothing in here touches the DOM or Firebase.

const STATUSES = ['open', 'in_progress', 'fixed'];
const SUBJECTS = ['Gameplay & Balance', 'UI & Navigation', 'Visuals & Juice', 'Technical / Architecture'];

const IMPACT_LABELS = { '1': 'Critical', '2': 'High', '3': 'Medium', '4': 'Low' };
const IMPACT_COLORS = {
    '1': 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200 border-red-300 dark:border-red-800',
    '2': 'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-200 border-orange-300 dark:border-orange-800',
    '3': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-200 border-yellow-300 dark:border-yellow-800',
    '4': 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200 border-green-300 dark:border-green-800'
};
const getImpactLabel = (val) => IMPACT_LABELS[String(val)] || 'Unknown';
const getImpactColor = (val) => IMPACT_COLORS[String(val)] || IMPACT_COLORS['4'];

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

function filterIssues(issues, { status = 'all', impact = 'all', milestone = 'all', query = '' } = {}) {
    const q = String(query).toLowerCase();
    return issues
        .filter(i => status === 'all' || i.status === status)
        .filter(i => impact === 'all' || String(i.impact) === String(impact))
        .filter(i => milestone === 'all' || i.milestone === milestone)
        .filter(i => !q || [i.desc, i.subject, i.tag, i.tags, i.milestone].some(f => String(f || '').toLowerCase().includes(q)))
        // Most urgent first, then oldest bug number first
        .sort((a, b) => (Number(a.impact) - Number(b.impact)) || (bugNum(a) - bugNum(b)));
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
function sanitizeIssue(raw) {
    const i = raw && typeof raw === 'object' ? raw : {};
    return {
        id: typeof i.id === 'string' && i.id && !i.id.includes('/') ? i.id : newId(),
        tag: typeof i.tag === 'string' ? i.tag : '',
        desc: String(i.desc ?? ''),
        subject: SUBJECTS.includes(i.subject) ? i.subject : SUBJECTS[0],
        impact: ['1', '2', '3', '4'].includes(String(i.impact)) ? String(i.impact) : '3',
        points: String(i.points ?? ''),
        milestone: String(i.milestone ?? ''),
        tags: String(i.tags ?? ''),
        status: STATUSES.includes(i.status) ? i.status : 'open',
        notes: Array.isArray(i.notes) ? i.notes.filter(n => n && typeof n === 'object').map(n => ({
            id: typeof n.id === 'string' ? n.id : newId(),
            text: String(n.text ?? ''),
            date: String(n.date ?? ''),
            author: String(n.author ?? '')
        })) : [],
        createdBy: String(i.createdBy ?? ''),
        createdAt: Number(i.createdAt) || 0,
        updatedBy: String(i.updatedBy ?? ''),
        updatedAt: Number(i.updatedAt) || 0
    };
}

// Returns sanitized issues, or null when the file is not a tracker backup.
function validateImport(data) {
    if (!Array.isArray(data)) return null;
    if (!data.every(i => i && typeof i === 'object' && typeof i.desc === 'string')) return null;
    const seen = new Set();
    return data.map(sanitizeIssue).map(i => {
        if (seen.has(i.id)) i.id = newId();
        seen.add(i.id);
        return i;
    });
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
        STATUSES, SUBJECTS, getImpactLabel, getImpactColor, esc, bugNum, fmtBug, nextBugNumber, newId,
        parseTags, normalizeProjectName, filterIssues, progressPct, milestonesOf, formatDate,
        sanitizeIssue, validateImport, parseAiJson, chunk
    };
}
