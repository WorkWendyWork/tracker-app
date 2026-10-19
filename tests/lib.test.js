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
    assert.deepEqual(lib.filterIssues(issues, { query: 'CRASH' }).map(i => i.id), ['b']);
    assert.deepEqual(lib.filterIssues(issues, { query: 'layout' }).map(i => i.id), ['c']);
    assert.deepEqual(lib.filterIssues(issues, { query: 'bug-0002' }).map(i => i.id), ['a']);
});

test('progressPct and milestonesOf', () => {
    assert.equal(lib.progressPct([]), 0);
    assert.equal(lib.progressPct([{ status: 'fixed' }, { status: 'open' }, { status: 'open' }]), 33);
    assert.deepEqual(lib.milestonesOf([{ milestone: 'B' }, { milestone: 'A' }, { milestone: 'B' }, {}]), ['A', 'B']);
});

test('sanitizeIssue fills defaults and rejects bad values', () => {
    const i = lib.sanitizeIssue({ id: 'x/y', desc: 5, impact: 9, status: 'deleted', subject: 'nope', notes: [null, { text: 'hi' }], evil: true });
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
