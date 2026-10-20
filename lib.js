// Pure helpers shared by the app (browser globals) and the tests (Node require).
// Nothing in here touches the DOM or Firebase.

const STATUSES = ['open', 'in_progress', 'fixed'];
const STATUS_LABELS = { open: 'Open', in_progress: 'In Progress', fixed: 'Fixed' };
// Default subjects; teams can edit their own list in ⚙️ Settings (see sanitizeConfig).
const SUBJECTS = ['Gameplay & Balance', 'UI & Navigation', 'Visuals & Juice', 'Technical / Architecture'];
const POINTS = ['1', '2', '3', '5', '8'];

// Keep in sync with validIssue() and meta/config in firestore.rules
const LIMITS = { desc: 20000, milestone: 60, subject: 60, tags: 300, note: 2000, notes: 200, history: 50, text: 200, subjects: 30, milestones: 50 };
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

// Team-editable lists (⚙️ Settings). Always returns a usable config.
function sanitizeConfig(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    // Trim, drop empties and case-insensitive duplicates (first spelling wins)
    const list = (v, max, n) => (Array.isArray(v) ? v : [])
        .map(s => String(s ?? '').trim().slice(0, max)).filter(Boolean)
        .filter((s, k, arr) => arr.findIndex(x => x.toLowerCase() === s.toLowerCase()) === k)
        .slice(0, n);
    const subjects = list(r.subjects, LIMITS.subject, LIMITS.subjects);
    return {
        subjects: subjects.length ? subjects : [...SUBJECTS],
        milestones: list(r.milestones, LIMITS.milestone, LIMITS.milestones)
    };
}

const SORTS = ['priority', 'subject', 'number', 'updated'];

// Unnumbered (NEW) issues sort after numbered ones
const byNumber = (a, b) => (bugNum(a) || Number.MAX_SAFE_INTEGER) - (bugNum(b) || Number.MAX_SAFE_INTEGER);
const byPriority = (a, b) => Number(a.impact) - Number(b.impact);
const byUpdated = (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);

// Subjects sort in the team's configured order; unknown ones last, alphabetically.
function makeComparators(subjects = SUBJECTS) {
    const rank = (s) => { const k = subjects.indexOf(s); return k < 0 ? subjects.length : k; };
    const bySubject = (a, b) => (rank(a.subject) - rank(b.subject)) || String(a.subject).localeCompare(String(b.subject));
    return {
        priority: (a, b) => byPriority(a, b) || byNumber(a, b),
        subject: (a, b) => bySubject(a, b) || byPriority(a, b) || byNumber(a, b),
        number: byNumber,
        updated: (a, b) => byUpdated(a, b) || byNumber(a, b)
    };
}

// ==========================================
// Filters
// A filter group with an empty array means "any". Within a group values are
// OR-ed (Open or In Progress); groups are AND-ed (… and Critical).
// Assignee uses the special values '@me' and '@none'; points uses 'none'.
// ==========================================
const FILTER_GROUPS = ['status', 'impact', 'subject', 'points', 'milestone', 'assignee', 'tags'];
// hideDone: leave fixed bugs out of the list and the filter counts ("what's left to do")
const EMPTY_FILTERS = Object.freeze({ q: '', status: [], impact: [], subject: [], points: [], milestone: [], assignee: [], tags: [], sort: 'priority', rev: false, hideDone: false });

const QUICK_VIEWS = {
    all: { label: 'All issues', filters: {} },
    mine: { label: 'My open', filters: { assignee: ['@me'], status: ['open', 'in_progress'] } },
    urgent: { label: 'Urgent', filters: { impact: ['1', '2'], status: ['open', 'in_progress'] } },
    unassigned: { label: 'Unassigned', filters: { assignee: ['@none'], status: ['open', 'in_progress'] } },
    recentFixed: { label: 'Recently fixed', filters: { status: ['fixed'], sort: 'updated' } }
};

function normalizeFilters(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const f = { q: clip(r.q, 200), sort: SORTS.includes(r.sort) ? r.sort : 'priority', rev: r.rev === true || r.rev === '1', hideDone: r.hideDone === true || r.hideDone === '1' };
    FILTER_GROUPS.forEach(k => {
        const v = Array.isArray(r[k]) ? r[k] : (r[k] == null || r[k] === '' ? [] : [r[k]]);
        f[k] = [...new Set(v.map(x => clip(x, LIMITS.text)).filter(Boolean))];
    });
    return f;
}

// Splits a search into terms: words, "quoted phrases", and -excluded words.
function parseSearch(q) {
    const terms = [];
    const re = /(-?)"([^"]*)"|(-?)(\S+)/g;
    let m;
    while ((m = re.exec(String(q || '')))) {
        const neg = (m[1] || m[3]) === '-';
        const text = (m[2] !== undefined ? m[2] : m[4]).toLowerCase().trim();
        if (text && text !== '-') terms.push({ text, neg });
    }
    return terms;
}

const searchableText = (i) => [i.desc, i.subject, i.tag, i.tags, i.milestone, i.assignee,
    ...(i.notes || []).map(n => n.text)].map(v => String(v || '')).join('\n').toLowerCase();

function filterIssues(issues, filters = {}, me = '', subjects = SUBJECTS) {
    const f = normalizeFilters(filters);
    const terms = parseSearch(f.q);
    const any = (arr, v) => !arr.length || arr.includes(v);
    const tagSet = new Set(f.tags.map(t => t.toLowerCase()));
    const cmp = makeComparators(subjects)[f.sort];
    return issues
        // Picking "Fixed" in the status filter wins over hiding completed bugs
        .filter(i => !f.hideDone || i.status !== 'fixed' || f.status.includes('fixed'))
        .filter(i => any(f.status, i.status))
        .filter(i => any(f.impact, String(i.impact)))
        .filter(i => any(f.subject, i.subject))
        .filter(i => any(f.points, i.points ? String(i.points) : 'none'))
        .filter(i => any(f.milestone, i.milestone || ''))
        .filter(i => !f.assignee.length || f.assignee.some(a =>
            a === '@me' ? (!!me && i.assignee === me) : a === '@none' ? !i.assignee : i.assignee === a))
        .filter(i => !tagSet.size || parseTags(i.tags).some(t => tagSet.has(t.toLowerCase())))
        .filter(i => {
            if (!terms.length) return true;
            const text = searchableText(i);
            return terms.every(t => text.includes(t.text) !== t.neg);
        })
        .sort(f.rev ? (a, b) => cmp(b, a) : cmp);
}

const activeFilterCount = (filters) => {
    const f = normalizeFilters(filters);
    return FILTER_GROUPS.filter(k => f[k].length).length + (f.q.trim() ? 1 : 0);
};

// The bugs filter counts are based on: all, or only unfinished ones when hiding completed.
const countBase = (issues, filters) => normalizeFilters(filters).hideDone ? issues.filter(i => i.status !== 'fixed') : issues;

// Which quick view (if any) the filters exactly match, ignoring the search box.
function matchingQuickView(filters) {
    const f = normalizeFilters(filters);
    const key = (x) => JSON.stringify({ ...normalizeFilters(x), q: '', hideDone: false });
    const target = key(f);
    return Object.keys(QUICK_VIEWS).find(k => key(QUICK_VIEWS[k].filters) === target) || '';
}

// Filters <-> URL query string (for shareable links). Defaults are omitted.
function filtersToQuery(filters) {
    const f = normalizeFilters(filters);
    const p = new URLSearchParams();
    if (f.q) p.set('q', f.q);
    FILTER_GROUPS.forEach(k => f[k].forEach(v => p.append(k, v)));
    if (f.sort !== 'priority') p.set('sort', f.sort);
    if (f.rev) p.set('rev', '1');
    if (f.hideDone) p.set('open', '1');
    return p.toString();
}

function queryToFilters(query) {
    const p = new URLSearchParams(String(query || '').replace(/^[#?]/, ''));
    const raw = { q: p.get('q') || '', sort: p.get('sort') || 'priority', rev: p.get('rev') === '1', hideDone: p.get('open') === '1' };
    FILTER_GROUPS.forEach(k => { raw[k] = p.getAll(k); });
    return normalizeFilters(raw);
}

// Unique tags across issues (case-insensitive), sorted.
function tagsOf(issues) {
    const seen = new Map();
    issues.forEach(i => parseTags(i.tags).forEach(t => { if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t); }));
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
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
        // Any subject the team created is allowed; renamed/deleted ones are migrated in Settings
        subject: clip(String(i.subject ?? '').trim(), LIMITS.subject) || SUBJECTS[0],
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

// ==========================================
// AI suggestions (Gemini)
// ctx = { subjects, milestones, tags } — the team's current choices.
// ==========================================
// A subject must be ONE topic: short, and not two things joined together.
const SUBJECT_RULE = 'A subject is ONE topic of 1-3 words in Title Case (e.g. "Audio", "Save System", "Combat"). Never combine two topics with "&", "/", "+", "," or "and".';

function isSingleSubject(name) {
    const s = String(name ?? '').trim();
    return s.length >= 2 && s.length <= 30 && s.split(/\s+/).length <= 3 && !/[&/+,|;]|\band\b/i.test(s);
}

// Tidies an AI-made subject name: trims, collapses spaces, capitalizes words.
const cleanSubjectName = (name) => String(name ?? '').trim().replace(/\s+/g, ' ')
    .replace(/(^|\s)(\p{Ll})/gu, (m, sp, c) => sp + c.toUpperCase()).slice(0, 30);

const quoteList = (arr) => arr.map(s => JSON.stringify(s)).join(', ');

function buildCategorizePrompt(desc, ctx = {}) {
    const subjects = (ctx.subjects && ctx.subjects.length ? ctx.subjects : SUBJECTS).slice(0, LIMITS.subjects);
    const milestones = (ctx.milestones || []).slice(0, LIMITS.milestones);
    const tags = (ctx.tags || []).slice(0, 100);
    const q = quoteList;
    return [
        'You triage bug reports for a video game team.',
        `Bug report: ${JSON.stringify(clip(desc, 4000))}`,
        '',
        'Return ONLY a JSON object with these keys:',
        `- "subject": the best fitting one of [${q(subjects)}]. If none of them is a good fit, create a NEW subject instead. ${SUBJECT_RULE}`,
        '- "impact": "1" (Critical: crash, data loss, blocks play), "2" (High), "3" (Medium) or "4" (Low: cosmetic, typo)',
        '- "points": story-point estimate of the fix effort, one of "1", "2", "3", "5", "8"',
        `- "tags": 1 to 4 short lowercase tags. Prefer existing tags: [${q(tags)}]. Only invent a new one if none fit.`,
        milestones.length
            ? `- "milestone": one of [${q(milestones)}] if the report clearly belongs to it, otherwise ""`
            : '- "milestone": ""',
        'No markdown, no explanation.'
    ].join('\n');
}

// Turns the AI's answer into safe form values; anything invalid becomes null.
function parseAiSuggestion(raw, ctx = {}) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const subjects = ctx.subjects && ctx.subjects.length ? ctx.subjects : SUBJECTS;
    const findCI = (list, v) => list.find(x => x.toLowerCase() === String(v ?? '').trim().toLowerCase());
    const existingTags = ctx.tags || [];
    const tags = (Array.isArray(r.tags) ? r.tags : parseTags(r.tags))
        .map(t => String(t ?? '').trim().replace(/,/g, ' ').slice(0, 30)).filter(Boolean)
        .map(t => findCI(existingTags, t) || t.toLowerCase())
        .filter((t, k, arr) => arr.indexOf(t) === k)
        .slice(0, 4);
    // Placeholders like "Uncategorised" or "Other" are never a valid answer
    const placeholder = isPlaceholderSubject(r.subject);
    const known = placeholder ? null : findCI(subjects, r.subject);
    const fresh = !known && !placeholder && isSingleSubject(r.subject) ? cleanSubjectName(r.subject) : null;
    return {
        subject: known || fresh || null,
        newSubject: !!fresh,
        impact: ['1', '2', '3', '4'].includes(String(r.impact)) ? String(r.impact) : null,
        points: POINTS.includes(String(r.points)) ? String(r.points) : null,
        tags: tags.length ? tags : null,
        milestone: findCI(ctx.milestones || [], r.milestone) || null
    };
}

// ==========================================
// "Reorganize with AI": two steps.
//  1. Taxonomy: read (a sample of) all bugs, propose a clean subject list.
//  2. Assign: in batches, pick a subject (+ tags) for every bug.
// Bugs are sent as { i, text } with short numeric ids to save tokens.
// ==========================================
const ORGANIZE_BATCH = 50;
const ORGANIZE_SAMPLE = 200;

// Short text for one bug: description plus its current tags.
const organizeText = (issue) => clip(String(issue.desc || '').replace(/\s+/g, ' ').trim(), 300) +
    (issue.tags ? ` [tags: ${clip(issue.tags, 80)}]` : '');

function buildTaxonomyPrompt(items, currentSubjects = []) {
    return [
        'You organize the bug backlog of a video game team.',
        `Their current subjects are: [${quoteList(currentSubjects)}]. Some combine two topics, which they do not want.`,
        '',
        `Propose a clean list of 4 to 15 subjects that together cover ALL of the bugs below. ${SUBJECT_RULE}`,
        'Reuse a current subject when it is already a single topic. Split combined ones into separate subjects only if bugs need both.',
        'Order the list from most to least important for the game.',
        '',
        'Bugs (JSON lines):',
        ...items.map(it => JSON.stringify({ i: it.i, text: it.text })),
        '',
        'Return ONLY JSON: {"subjects": ["...", "..."]}'
    ].join('\n');
}

function parseTaxonomy(raw) {
    const list = raw && Array.isArray(raw.subjects) ? raw.subjects : [];
    return list.filter(isSingleSubject).map(cleanSubjectName)
        .filter((s, k, arr) => arr.findIndex(x => x.toLowerCase() === s.toLowerCase()) === k)
        .slice(0, 15);
}

function buildAssignPrompt(items, subjects, tags = []) {
    return [
        'You organize the bug backlog of a video game team.',
        `Subjects (use EXACTLY one of these per bug): [${quoteList(subjects)}]`,
        `Existing tags (prefer these): [${quoteList(tags.slice(0, 150))}]`,
        '',
        'For every bug below choose the best subject and 1 to 4 short lowercase tags.',
        '',
        'Bugs (JSON lines):',
        ...items.map(it => JSON.stringify({ i: it.i, text: it.text })),
        '',
        'Return ONLY JSON: {"assignments": [{"i": 0, "subject": "...", "tags": ["..."]}, ...]} with one entry per bug.'
    ].join('\n');
}

// Returns Map(i -> { subject, tags }) for valid answers only.
function parseAssignments(raw, ids, subjects, existingTags = []) {
    const out = new Map();
    const valid = new Set(ids);
    (raw && Array.isArray(raw.assignments) ? raw.assignments : []).forEach(a => {
        const i = Number(a && a.i);
        if (!valid.has(i) || out.has(i)) return;
        const s = parseAiSuggestion({ subject: a.subject, tags: a.tags }, { subjects, tags: existingTags });
        if (s.subject && !s.newSubject) out.set(i, { subject: s.subject, tags: s.tags || [] });
    });
    return out;
}

// Picks the best available Gemini "flash" model from a models.list response,
// so the app keeps working when Google retires a model name.
// Any text-generating Gemini model works; "flash" models are preferred (fast, cheap).
function pickGeminiModel(models) {
    const usable = (Array.isArray(models) ? models : [])
        .filter(m => m && typeof m.name === 'string' && /^models\/gemini-/.test(m.name))
        .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
        .filter(m => !/(tts|image|audio|live|embedding|thinking|exp|vision|native)/i.test(m.name));
    const version = (n) => parseFloat((n.match(/gemini-([\d.]+)/) || [])[1]) || 0;
    const score = (n) => (/flash/.test(n) ? 1000 : 0) + version(n) * 100
        - (/lite/.test(n) ? 5 : 0) - (/preview/.test(n) ? 3 : 0) - (/-\d{3,}$/.test(n) ? 1 : 0)
        + (/-latest$/.test(n) && !version(n) ? 50 : 0);
    usable.sort((a, b) => score(b.name) - score(a.name));
    return usable.length ? usable[0].name.replace(/^models\//, '') : null;
}

// Tried in order when Google's model list can't be read.
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'];

// ==========================================
// ✨ AI fill: suggestions for many bugs in one request.
// ==========================================
const FILL_BATCH = 25;
const FILL_FIELDS = ['subject', 'impact', 'points', 'tags', 'milestone'];

// Placeholder subjects mean "not categorised yet".
const isPlaceholderSubject = (s) => /^(un-?categori[sz]ed|uncategori[sz]ed|other|others|misc|miscellaneous|general|none|n\/?a|todo|tbd|unknown|new)$/i.test(String(s ?? '').trim());

// A real subject: one topic, from the team list, not a placeholder.
const isGoodSubject = (s, subjects) => isSingleSubject(s) && !isPlaceholderSubject(s) &&
    subjects.some(x => x.toLowerCase() === String(s).toLowerCase());

// A bug is missing info when it has no story points, no tags, no milestone,
// or a subject that isn't a proper single-topic subject from the team list.
function needsAiFill(issue, subjects = SUBJECTS, milestones = []) {
    const okSubject = isGoodSubject(issue.subject, subjects);
    return !okSubject || !issue.points || !parseTags(issue.tags).length || (milestones.length > 0 && !issue.milestone);
}

function buildFillPrompt(items, ctx = {}) {
    const subjects = (ctx.subjects && ctx.subjects.length ? ctx.subjects : SUBJECTS).slice(0, LIMITS.subjects);
    const milestones = (ctx.milestones || []).slice(0, LIMITS.milestones);
    const tags = (ctx.tags || []).slice(0, 150);
    return [
        'You triage bug reports for a video game team.',
        '',
        'For EVERY bug below return:',
        `- "subject": the best fitting one of [${quoteList(subjects)}], or a NEW subject if none fits. ${SUBJECT_RULE}`,
        '- "impact": "1" (Critical: crash, data loss, blocks play), "2" (High), "3" (Medium) or "4" (Low: cosmetic, typo)',
        '- "points": story-point estimate of the fix effort, one of "1", "2", "3", "5", "8"',
        `- "tags": 1 to 4 short lowercase tags. Prefer existing tags: [${quoteList(tags)}]`,
        milestones.length
            ? `- "milestone": one of [${quoteList(milestones)}] that fits best (urgent and small work goes first)`
            : '- "milestone": ""',
        '',
        'Bugs (JSON lines):',
        ...items.map(it => JSON.stringify({ i: it.i, text: it.text })),
        '',
        'Return ONLY JSON: {"results": [{"i": 0, "subject": "...", "impact": "2", "points": "3", "tags": ["..."], "milestone": "..."}, ...]} with one entry per bug.'
    ].join('\n');
}

// Returns Map(i -> suggestion as from parseAiSuggestion) for answers with at least one usable field.
function parseFillResults(raw, ids, ctx = {}) {
    const out = new Map();
    const valid = new Set(ids);
    (raw && Array.isArray(raw.results) ? raw.results : []).forEach(r => {
        const i = Number(r && r.i);
        if (!valid.has(i) || out.has(i)) return;
        const s = parseAiSuggestion(r, ctx);
        if (FILL_FIELDS.some(f => s[f])) out.set(i, s);
    });
    return out;
}

// What the AI would change on one bug. onlyEmpty: never overwrite what's already set.
function planFill(issue, s, { fields = FILL_FIELDS, onlyEmpty = true, subjects = SUBJECTS } = {}) {
    const out = {};
    const want = new Set(fields);
    const subjectOk = isGoodSubject(issue.subject, subjects);
    if (want.has('subject') && s.subject && s.subject !== issue.subject && (!onlyEmpty || !subjectOk)) out.subject = s.subject;
    if (want.has('impact') && s.impact && s.impact !== String(issue.impact) && !onlyEmpty) out.impact = s.impact;
    if (want.has('points') && s.points && s.points !== issue.points && (!onlyEmpty || !issue.points)) out.points = s.points;
    if (want.has('milestone') && s.milestone && s.milestone !== issue.milestone && (!onlyEmpty || !issue.milestone)) out.milestone = s.milestone;
    if (want.has('tags') && s.tags && (!onlyEmpty || !parseTags(issue.tags).length)) {
        const merged = parseTags(issue.tags);
        s.tags.forEach(t => { if (!merged.some(m => m.toLowerCase() === t.toLowerCase())) merged.push(t); });
        const joined = clip(merged.join(', '), LIMITS.tags);
        if (joined !== parseTags(issue.tags).join(', ')) out.tags = joined;
    }
    return out;
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
        parseTags, normalizeProjectName, filterIssues, FILTER_GROUPS, EMPTY_FILTERS, QUICK_VIEWS,
        normalizeFilters, parseSearch, countBase, activeFilterCount, matchingQuickView, filtersToQuery, queryToFilters, tagsOf, progressPct, milestonesOf, formatDate,
        sanitizeIssue, validateImport, describeChanges, withHistory,
        sanitizeConfig, makeComparators, buildCategorizePrompt, parseAiSuggestion, pickGeminiModel,
        isSingleSubject, cleanSubjectName, ORGANIZE_BATCH, ORGANIZE_SAMPLE, organizeText,
        buildTaxonomyPrompt, parseTaxonomy, buildAssignPrompt, parseAssignments,
        FALLBACK_MODELS, FILL_BATCH, FILL_FIELDS, needsAiFill, isPlaceholderSubject, isGoodSubject, buildFillPrompt, parseFillResults, planFill,
        checkImageFile, parseAiJson, chunk
    };
}
