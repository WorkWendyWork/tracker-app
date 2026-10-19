const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib.js');

test('esc neutralizes HTML and attribute breakouts', () => {
    assert.equal(lib.esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(lib.esc(`"'\`&`), '&quot;&#39;&#96;&amp;');
    assert.equal(lib.esc(null), '');
    assert.equal(lib.esc(42), '42');
});

test('bug numbers are formatted and incremented', () => {
    assert.equal(lib.fmtBug(7), 'BUG-0007');
    assert.equal(lib.fmtBug(12345), 'BUG-12345');
    assert.equal(lib.bugNum({ tag: 'BUG-0042' }), 42);
    assert.equal(lib.bugNum({ tag: 'weird' }), 0);
    assert.equal(lib.nextBugNumber([]), 1);
    assert.equal(lib.nextBugNumber([{ tag: 'BUG-0003' }, { tag: 'BUG-0010' }, {}]), 11);
});

test('newId returns unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, lib.newId));
    assert.equal(ids.size, 1000);
});

test('parseTags trims and drops empties', () => {
    assert.deepEqual(lib.parseTags(' Audio, ,UI ,Physics,'), ['Audio', 'UI', 'Physics']);
    assert.deepEqual(lib.parseTags(undefined), []);
});

test('normalizeProjectName strips unsafe characters', () => {
    assert.equal(lib.normalizeProjectName('  My/Game..v2!  '), 'MyGamev2');
    assert.equal(lib.normalizeProjectName('alpha_1 - beta'), 'alpha_1 - beta');
    assert.equal(lib.normalizeProjectName('x'.repeat(100)).length, 60);
});

test('filterIssues filters and sorts by priority then number', () => {
    const issues = [
        { id: 'a', tag: 'BUG-0002', impact: '3', status: 'open', desc: 'Jump is floaty', subject: 'Gameplay & Balance', milestone: 'Alpha' },
        { id: 'b', tag: 'BUG-0001', impact: '1', status: 'fixed', desc: 'Crash on load', subject: 'Technical / Architecture', milestone: 'Beta' },
        { id: 'c', tag: 'BUG-0003', impact: '1', status: 'open', desc: 'Menu overlaps', subject: 'UI & Navigation', tags: 'ui, layout' }
    ];
    assert.deepEqual(lib.filterIssues(issues).map(i => i.id), ['b', 'c', 'a']);
    assert.deepEqual(lib.filterIssues(issues, { status: 'open' }).map(i => i.id), ['c', 'a']);
    assert.deepEqual(lib.filterIssues(issues, { impact: 1 }).map(i => i.id), ['b', 'c']);
    assert.deepEqual(lib.filterIssues(issues, { milestone: 'Alpha' }).map(i => i.id), ['a']);
    assert.deepEqual(lib.filterIssues(issues, { q: 'CRASH' }).map(i => i.id), ['b']);
    assert.deepEqual(lib.filterIssues(issues, { q: 'layout' }).map(i => i.id), ['c']);
    assert.deepEqual(lib.filterIssues(issues, { q: 'bug-0002' }).map(i => i.id), ['a']);
});

test('filterIssues sort options', () => {
    const issues = [
        { id: 'a', tag: 'BUG-0003', impact: '2', status: 'open', desc: '', subject: 'Technical / Architecture', updatedAt: 10 },
        { id: 'b', tag: 'BUG-0001', impact: '3', status: 'open', desc: '', subject: 'Gameplay & Balance', updatedAt: 30 },
        { id: 'c', tag: 'BUG-0002', impact: '1', status: 'open', desc: '', subject: 'Gameplay & Balance', createdAt: 20 },
        { id: 'd', tag: '', impact: '1', status: 'open', desc: '', subject: 'UI & Navigation' }
    ];
    const ids = (sort) => lib.filterIssues(issues, { sort }).map(i => i.id).join('');
    assert.equal(ids('priority'), 'cdab');
    assert.equal(ids('subject'), 'cbda');
    assert.equal(ids('number'), 'bcad');
    assert.equal(ids('updated'), 'bcad');
    assert.equal(ids('bogus'), 'cdab');
    assert.deepEqual(lib.SORTS, ['priority', 'subject', 'number', 'updated']);
});

test('advanced filters: multi-select groups, tags, points, reverse sort', () => {
    const issues = [
        { id: 'a', tag: 'BUG-0001', impact: '1', status: 'open', desc: 'Crash', subject: 'Technical / Architecture', points: '5', tags: 'Audio, UI' },
        { id: 'b', tag: 'BUG-0002', impact: '2', status: 'in_progress', desc: 'Lag', subject: 'Technical / Architecture', points: '', tags: 'perf' },
        { id: 'c', tag: 'BUG-0003', impact: '3', status: 'fixed', desc: 'Color', subject: 'Visuals & Juice', points: '1', tags: 'ui' },
        { id: 'd', tag: 'BUG-0004', impact: '4', status: 'open', desc: 'Typo', subject: 'UI & Navigation', milestone: 'Beta' }
    ];
    const ids = (f, me) => lib.filterIssues(issues, f, me).map(i => i.id).join('');
    assert.equal(ids({ status: ['open', 'in_progress'] }), 'abd');
    assert.equal(ids({ status: ['open'], impact: ['1', '4'] }), 'ad');
    assert.equal(ids({ subject: ['Technical / Architecture', 'Visuals & Juice'] }), 'abc');
    assert.equal(ids({ points: ['none'] }), 'bd');
    assert.equal(ids({ points: ['1', '5'] }), 'ac');
    assert.equal(ids({ tags: ['UI'] }), 'ac');          // case-insensitive
    assert.equal(ids({ milestone: ['Beta'] }), 'd');
    assert.equal(ids({ rev: true }), 'dcba');
    assert.equal(ids({ sort: 'number', rev: true }), 'dcba');
});

test('search supports multiple words, phrases, exclusions and notes', () => {
    const issues = [
        { id: 'a', impact: '1', status: 'open', desc: 'Player falls through floor', subject: 'Gameplay & Balance', notes: [{ text: 'only on level 3' }] },
        { id: 'b', impact: '1', status: 'open', desc: 'Player floor texture blurry', subject: 'Visuals & Juice', notes: [] },
        { id: 'c', impact: '1', status: 'open', desc: 'Menu falls apart', subject: 'UI & Navigation', notes: [] }
    ];
    const ids = (q) => lib.filterIssues(issues, { q }).map(i => i.id).join('');
    assert.equal(ids('player floor'), 'ab');
    assert.equal(ids('"falls through"'), 'a');
    assert.equal(ids('falls -menu'), 'a');
    assert.equal(ids('level 3'), 'a');
    assert.equal(ids('-"floor texture"'), 'ac');
    assert.equal(ids('   '), 'abc');
    assert.deepEqual(lib.parseSearch('a "b c" -d -"e f" -'), [
        { text: 'a', neg: false }, { text: 'b c', neg: false }, { text: 'd', neg: true }, { text: 'e f', neg: true }
    ]);
});

test('normalizeFilters, counts and quick views', () => {
    const f = lib.normalizeFilters({ status: 'open', impact: ['1', '1', ''], sort: 'nope', rev: '1', junk: 1 });
    assert.deepEqual(f.status, ['open']);
    assert.deepEqual(f.impact, ['1']);
    assert.equal(f.sort, 'priority');
    assert.equal(f.rev, true);
    assert.equal('junk' in f, false);
    assert.equal(lib.activeFilterCount({}), 0);
    assert.equal(lib.activeFilterCount({ q: 'x', status: ['open'], tags: ['a', 'b'] }), 3);
    assert.equal(lib.matchingQuickView({}), 'all');
    assert.equal(lib.matchingQuickView({ q: 'crash' }), 'all');
    assert.equal(lib.matchingQuickView({ status: ['open', 'in_progress'], impact: ['1', '2'] }), 'urgent');
    assert.equal(lib.matchingQuickView({ status: ['open'] }), '');
});

test('filters round-trip through the URL', () => {
    const f = { q: 'crash "on load"', status: ['open', 'fixed'], milestone: ['Alpha, v1'], assignee: ['@me', 'ann@x.com'], tags: ['UI'], sort: 'subject', rev: true };
    const qs = lib.filtersToQuery(f);
    assert.deepEqual(lib.queryToFilters('#' + qs), lib.normalizeFilters(f));
    assert.equal(lib.filtersToQuery({}), '');
    assert.deepEqual(lib.queryToFilters(''), lib.normalizeFilters({}));
    assert.deepEqual(lib.queryToFilters('status=hacked&sort=evil').sort, 'priority');
});

test('hide completed: leaves fixed bugs out of the list and the counts', () => {
    const issues = [
        { id: 'a', impact: '1', status: 'open', desc: '', subject: 'Audio', tags: 'sound' },
        { id: 'b', impact: '1', status: 'fixed', desc: '', subject: 'Audio', tags: 'sound, crash' },
        { id: 'c', impact: '1', status: 'in_progress', desc: '', subject: 'Menus' },
        { id: 'd', impact: '1', status: 'fixed', desc: '', subject: 'Pets' }
    ];
    const ids = (f) => lib.filterIssues(issues, f).map(i => i.id).join('');
    assert.equal(ids({}), 'abcd');
    assert.equal(ids({ hideDone: true }), 'ac');
    assert.equal(ids({ hideDone: true, status: ['fixed'] }), 'bd');   // explicit choice wins
    assert.equal(ids({ hideDone: true, subject: ['Pets'] }), '');
    assert.deepEqual(lib.countBase(issues, { hideDone: true }).map(i => i.id), ['a', 'c']);
    assert.equal(lib.countBase(issues, {}).length, 4);
    // remembered in links, and quick views still match
    assert.equal(lib.queryToFilters('#' + lib.filtersToQuery({ hideDone: true })).hideDone, true);
    assert.equal(lib.filtersToQuery({ hideDone: true }), 'open=1');
    assert.equal(lib.matchingQuickView({ hideDone: true }), 'all');
    assert.equal(lib.activeFilterCount({ hideDone: true }), 0);
});

test('tagsOf', () => {
    assert.deepEqual(lib.tagsOf([{ tags: 'UI, audio' }, { tags: 'ui, Physics' }, {}]), ['audio', 'Physics', 'UI']);
});

test('progressPct and milestonesOf', () => {
    assert.equal(lib.progressPct([]), 0);
    assert.equal(lib.progressPct([{ status: 'fixed' }, { status: 'open' }, { status: 'open' }]), 33);
    assert.deepEqual(lib.milestonesOf([{ milestone: 'B' }, { milestone: 'A' }, { milestone: 'B' }, {}]), ['A', 'B']);
});

test('sanitizeIssue fills defaults and rejects bad values', () => {
    const i = lib.sanitizeIssue({ id: 'x/y', desc: 5, impact: 9, status: 'deleted', subject: '   ', notes: [null, { text: 'hi' }], evil: true });
    assert.notEqual(i.id, 'x/y');
    assert.equal(i.desc, '5');
    assert.equal(i.impact, '3');
    assert.equal(i.status, 'open');
    assert.equal(i.subject, lib.SUBJECTS[0]);
    assert.equal(i.notes.length, 1);
    assert.equal(i.notes[0].text, 'hi');
    assert.ok(i.notes[0].id);
    assert.equal('evil' in i, false);
});

test('sanitizeIssue enforces the same limits as firestore.rules', () => {
    const i = lib.sanitizeIssue({
        id: 'ok-id_1', tag: 'BUG-0001x', desc: 'x'.repeat(30000), milestone: 'm'.repeat(100), tags: 't'.repeat(400),
        points: '13', notes: Array(300).fill({ text: 'n'.repeat(3000) }), history: Array(80).fill({ text: 'h', at: 1 })
    });
    assert.equal(i.id, 'ok-id_1');
    assert.equal(i.tag, '');
    assert.equal(i.desc.length, lib.LIMITS.desc);
    assert.equal(i.milestone.length, lib.LIMITS.milestone);
    assert.equal(i.tags.length, lib.LIMITS.tags);
    assert.equal(i.points, '');
    assert.equal(i.notes.length, lib.LIMITS.notes);
    assert.equal(i.notes[0].text.length, lib.LIMITS.note);
    assert.equal(i.history.length, lib.LIMITS.history);
});

test('filterIssues by assignee', () => {
    const issues = [
        { id: 'a', impact: '1', status: 'open', desc: '', assignee: 'me@x.com' },
        { id: 'b', impact: '1', status: 'open', desc: '', assignee: 'you@x.com' },
        { id: 'c', impact: '1', status: 'open', desc: '' }
    ];
    assert.deepEqual(lib.filterIssues(issues, { assignee: ['@me'] }, 'me@x.com').map(i => i.id), ['a']);
    assert.deepEqual(lib.filterIssues(issues, { assignee: ['@me'] }, '').map(i => i.id), []);
    assert.deepEqual(lib.filterIssues(issues, { assignee: ['@none'] }).map(i => i.id), ['c']);
});

test('describeChanges and withHistory', () => {
    const before = { status: 'open', impact: '3', desc: 'a', assignee: '' };
    assert.equal(lib.describeChanges(before, { status: 'fixed' }), 'status → Fixed');
    assert.equal(lib.describeChanges(before, { impact: '1', desc: 'b' }), 'priority → Critical, description edited');
    assert.equal(lib.describeChanges(before, { assignee: 'x@y.z' }), 'assigned → x@y.z');
    assert.equal(lib.describeChanges(before, { status: 'open', desc: 'a' }), '');
    assert.deepEqual(lib.withHistory([], 'Ann', ''), []);
    const h = lib.withHistory([], 'Ann', 'created', 5);
    assert.deepEqual(h, [{ at: 5, by: 'Ann', text: 'created' }]);
    let long = [];
    for (let k = 0; k < 60; k++) long = lib.withHistory(long, 'A', 'e' + k);
    assert.equal(long.length, lib.LIMITS.history);
    assert.equal(long[long.length - 1].text, 'e59');
});

test('categorize prompt includes the team choices and asks for every field', () => {
    const p = lib.buildCategorizePrompt('Game "crashes" on load', { subjects: ['Audio', 'Netcode'], milestones: ['Alpha'], tags: ['crash'] });
    assert.match(p, /\["Audio", "Netcode"\]/);
    assert.match(p, /\["Alpha"\]/);
    assert.match(p, /\["crash"\]/);
    for (const k of ['subject', 'impact', 'points', 'tags', 'milestone']) assert.match(p, new RegExp(`"${k}"`));
    assert.match(p, /"Game \\"crashes\\" on load"/); // description is JSON-quoted, not injectable
    assert.ok(lib.buildCategorizePrompt('x'.repeat(10000)).length < 5000);
    assert.match(lib.buildCategorizePrompt('x'), /Gameplay & Balance/); // defaults
    assert.match(lib.buildCategorizePrompt('x'), /"milestone": ""/);
});

test('parseAiSuggestion keeps only valid values', () => {
    const ctx = { subjects: ['Audio', 'Netcode'], milestones: ['Alpha v1'], tags: ['Crash', 'ui'] };
    assert.deepEqual(lib.parseAiSuggestion({ subject: 'audio', impact: 1, points: '5', tags: ['crash', 'New Tag', 'crash', 'a,b'], milestone: 'alpha v1' }, ctx), {
        subject: 'Audio', newSubject: false, impact: '1', points: '5', tags: ['Crash', 'new tag', 'a b'], milestone: 'Alpha v1'
    });
    assert.deepEqual(lib.parseAiSuggestion({ subject: 'Graphics & VFX', impact: '9', points: '4', tags: [], milestone: 'Beta' }, ctx), {
        subject: null, newSubject: false, impact: null, points: null, tags: null, milestone: null
    });
    assert.deepEqual(lib.parseAiSuggestion({ tags: 'one, two, three, four, five' }, ctx).tags, ['one', 'two', 'three', 'four']);
    assert.deepEqual(lib.parseAiSuggestion(null, ctx).subject, null);
});

test('single-topic subjects', () => {
    for (const ok of ['Audio', 'Save System', 'Combat AI', 'UI']) assert.equal(lib.isSingleSubject(ok), true, ok);
    for (const bad of ['UI & Navigation', 'Technical / Architecture', 'Audio and Music', 'A', 'Too Many Words Here', 'x,y', 'Graphics + VFX', 'x'.repeat(31)]) {
        assert.equal(lib.isSingleSubject(bad), false, bad);
    }
    assert.equal(lib.cleanSubjectName('  save   system '), 'Save System');
    assert.equal(lib.cleanSubjectName('ÉCRAN titre'), 'ÉCRAN Titre');
});

test('AI may invent a new single-topic subject, never a combined one', () => {
    const ctx = { subjects: ['Audio', 'Combat'], tags: [] };
    assert.deepEqual(
        [lib.parseAiSuggestion({ subject: 'combat' }, ctx).subject, lib.parseAiSuggestion({ subject: 'combat' }, ctx).newSubject],
        ['Combat', false]);
    const fresh = lib.parseAiSuggestion({ subject: 'save system' }, ctx);
    assert.equal(fresh.subject, 'Save System');
    assert.equal(fresh.newSubject, true);
    assert.equal(lib.parseAiSuggestion({ subject: 'Save & Load' }, ctx).subject, null);
    assert.match(lib.buildCategorizePrompt('x', ctx), /create a NEW subject/);
    assert.match(lib.buildCategorizePrompt('x', ctx), /Never combine two topics/);
});

test('reorganize: taxonomy prompt and parsing', () => {
    const items = [{ i: 0, text: 'Sound cuts out' }, { i: 1, text: 'Menu "overlaps"' }];
    const p = lib.buildTaxonomyPrompt(items, ['UI & Navigation']);
    assert.match(p, /\["UI & Navigation"\]/);
    assert.match(p, /\{"i":1,"text":"Menu \\"overlaps\\""\}/);
    assert.match(p, /"subjects"/);
    assert.deepEqual(lib.parseTaxonomy({ subjects: ['audio', 'UI & Navigation', 'Audio', 'Menus', 'save   system'] }), ['Audio', 'Menus', 'Save System']);
    assert.deepEqual(lib.parseTaxonomy(null), []);
    assert.equal(lib.parseTaxonomy({ subjects: Array.from({ length: 30 }, (_, k) => 'Topic ' + k) }).length, 15);
    assert.equal(lib.organizeText({ desc: 'a\n\n b'.padEnd(500, 'x'), tags: 'ui' }).startsWith('a b'), true);
    assert.match(lib.organizeText({ desc: 'x', tags: 'ui, crash' }), /\[tags: ui, crash\]$/);
});

test('reorganize: assignment parsing keeps only valid answers', () => {
    const subjects = ['Audio', 'Menus'];
    const raw = { assignments: [
        { i: 0, subject: 'audio', tags: ['sound', 'Crash'] },
        { i: 1, subject: 'Graphics', tags: [] },        // not in list -> dropped
        { i: 2, subject: 'Menus' },
        { i: 0, subject: 'Menus' },                     // duplicate -> first wins
        { i: 9, subject: 'Audio' }                      // unknown id -> dropped
    ] };
    const m = lib.parseAssignments(raw, [0, 1, 2], subjects, ['crash']);
    assert.deepEqual([...m.keys()], [0, 2]);
    assert.deepEqual(m.get(0), { subject: 'Audio', tags: ['sound', 'crash'] });
    assert.deepEqual(m.get(2), { subject: 'Menus', tags: [] });
    assert.equal(lib.parseAssignments(null, [0], subjects).size, 0);
    assert.match(lib.buildAssignPrompt([{ i: 0, text: 't' }], subjects, ['crash']), /EXACTLY one of these per bug\): \["Audio", "Menus"\]/);
});

test('pickGeminiModel chooses the newest stable flash model', () => {
    const m = (name, methods = ['generateContent']) => ({ name: `models/${name}`, supportedGenerationMethods: methods });
    assert.equal(lib.pickGeminiModel([m('gemini-2.0-flash'), m('gemini-2.5-flash'), m('gemini-2.5-flash-lite'), m('gemini-2.5-pro')]), 'gemini-2.5-flash');
    assert.equal(lib.pickGeminiModel([m('gemini-3.0-flash-preview'), m('gemini-2.5-flash')]), 'gemini-3.0-flash-preview');
    assert.equal(lib.pickGeminiModel([m('gemini-3.0-flash'), m('gemini-3.0-flash-preview')]), 'gemini-3.0-flash');
    assert.equal(lib.pickGeminiModel([m('gemini-2.5-flash-preview-tts'), m('gemini-2.0-flash-lite')]), 'gemini-2.0-flash-lite');
    assert.equal(lib.pickGeminiModel([m('gemini-2.5-flash', ['embedContent'])]), null);
    assert.equal(lib.pickGeminiModel(undefined), null);
});

test('sanitizeConfig', () => {
    assert.deepEqual(lib.sanitizeConfig(null), { subjects: lib.SUBJECTS, milestones: [] });
    assert.deepEqual(lib.sanitizeConfig({ subjects: [' Audio ', 'audio', '', 'Netcode'], milestones: ['Alpha', 'alpha', 'Beta'], evil: 1 }), {
        subjects: ['Audio', 'Netcode'], milestones: ['Alpha', 'Beta']
    });
    assert.equal(lib.sanitizeConfig({ subjects: Array.from({ length: 40 }, (_, k) => 's' + k) }).subjects.length, lib.LIMITS.subjects);
    assert.deepEqual(lib.sanitizeConfig({ subjects: [] }).subjects, lib.SUBJECTS);
});

test('subject sort follows the team order, unknown subjects last', () => {
    const issues = ['Netcode', 'Zzz', 'Audio', 'Aaa'].map((subject, k) => ({ id: String(k), tag: `BUG-000${k + 1}`, impact: '3', status: 'open', desc: '', subject }));
    const order = lib.filterIssues(issues, { sort: 'subject' }, '', ['Netcode', 'Audio']).map(i => i.subject);
    assert.deepEqual(order, ['Netcode', 'Audio', 'Aaa', 'Zzz']);
});

test('checkImageFile', () => {
    assert.equal(lib.checkImageFile({ type: 'image/png', size: 1000 }), '');
    assert.match(lib.checkImageFile({ type: 'image/svg+xml', size: 10 }), /Only/);
    assert.match(lib.checkImageFile({ type: 'image/jpeg', size: lib.MAX_IMAGE_BYTES + 1 }), /5 MB/);
    assert.match(lib.checkImageFile(null), /No file/);
});

test('validateImport clears duplicate bug numbers', () => {
    const out = lib.validateImport([{ id: 'a', desc: 'x', tag: 'BUG-0001' }, { id: 'b', desc: 'y', tag: 'BUG-0001' }]);
    assert.equal(out[0].tag, 'BUG-0001');
    assert.equal(out[1].tag, '');
});

test('validateImport accepts backups and rejects junk', () => {
    assert.equal(lib.validateImport({}), null);
    assert.equal(lib.validateImport([{ nope: 1 }]), null);
    const out = lib.validateImport([{ id: 'same', desc: 'a' }, { id: 'same', desc: 'b' }]);
    assert.equal(out.length, 2);
    assert.notEqual(out[0].id, out[1].id);
});

test('parseAiJson handles fenced and plain output', () => {
    assert.deepEqual(lib.parseAiJson('```json\n{"impact": 2}\n```'), { impact: 2 });
    assert.deepEqual(lib.parseAiJson('```\n{"impact": 3}\n```'), { impact: 3 });
    assert.deepEqual(lib.parseAiJson(' {"subject":"UI & Navigation"} '), { subject: 'UI & Navigation' });
    assert.throws(() => lib.parseAiJson('not json'));
});

test('chunk splits arrays', () => {
    assert.deepEqual(lib.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(lib.chunk([], 3), []);
});

test('impact helpers', () => {
    assert.equal(lib.getImpactLabel('1'), 'Critical');
    assert.equal(lib.getImpactLabel(4), 'Low');
    assert.equal(lib.getImpactLabel('9'), 'Unknown');
    assert.match(lib.getImpactColor('2'), /orange/);
});
