// Runs against the Firebase emulator (needs Java):  npm run test:rules
const test = require('node:test');
const { before, after, beforeEach } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { sanitizeIssue } = require('../../lib.js');

const MEMBER = 'your-email@example.com'; // the placeholder in firestore.rules
const WS = 'workspaces/default_workspace';
let env;

before(async () => {
    env = await initializeTestEnvironment({
        projectId: 'demo-bug-tracker',
        firestore: { rules: fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8') }
    });
});
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const member = () => env.authenticatedContext('u1', { email: MEMBER, email_verified: true }).firestore();
const outsider = () => env.authenticatedContext('u2', { email: 'stranger@example.com', email_verified: true }).firestore();
const unverified = () => env.authenticatedContext('u3', { email: MEMBER, email_verified: false }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

const issue = (over = {}) => ({ ...sanitizeIssue({ id: 'i1', desc: 'Crash on load', subject: 'Gameplay & Balance', impact: '1', status: 'open' }), ...over });
const issueDoc = (db, id = 'i1') => db.doc(`${WS}/projects/main/issues/${id}`);

test('team member can create, read, update and delete a valid issue', async () => {
    const db = member();
    await assertSucceeds(issueDoc(db).set(issue()));
    await assertSucceeds(issueDoc(db).get());
    await assertSucceeds(issueDoc(db).update({ status: 'fixed', tag: 'BUG-0001' }));
    await assertSucceeds(issueDoc(db).delete());
});

test('sanitizeIssue output always passes the rules', async () => {
    const weird = sanitizeIssue({ id: 'i1', desc: 'x'.repeat(50000), impact: 7, notes: Array(500).fill({ text: 'n' }), history: Array(80).fill({ text: 'h' }), extra: 1 });
    await assertSucceeds(issueDoc(member()).set(weird));
});

test('outsiders, unverified emails and signed-out users are denied', async () => {
    await env.withSecurityRulesDisabled(c => issueDoc(c.firestore()).set(issue()));
    for (const db of [outsider(), unverified(), anon()]) {
        await assertFails(issueDoc(db).get());
        await assertFails(issueDoc(db, 'i2').set(issue({ id: 'i2' })));
        await assertFails(db.doc(`${WS}/meta/projects`).get());
    }
});

test('invalid issues are rejected', async () => {
    const db = member();
    const bad = [
        issue({ impact: '9' }),
        issue({ status: 'deleted' }),
        issue({ subject: 'Other' }),
        issue({ tag: 'HACK' }),
        issue({ desc: 'x'.repeat(20001) }),
        issue({ points: '13' }),
        issue({ evil: true }),
        issue({ id: 'different' }),
        issue({ notes: 'not a list' })
    ];
    for (const d of bad) await assertFails(issueDoc(db).set(d));
});

test('project counter and lists are validated', async () => {
    const db = member();
    await assertSucceeds(db.doc(`${WS}/projects/main`).set({ nextBug: 2 }));
    await assertFails(db.doc(`${WS}/projects/main`).set({ nextBug: 'two' }));
    await assertFails(db.doc(`${WS}/projects/main`).set({ nextBug: 0 }));
    await assertSucceeds(db.doc(`${WS}/meta/projects`).set({ list: ['main', 'Beta'] }));
    await assertFails(db.doc(`${WS}/meta/projects`).set({ list: [] }));
    await assertFails(db.doc(`${WS}/meta/settings`).set({ engine: 'Godot' })); // removed feature: locked
});

test('ops journal accepts only known job types', async () => {
    const db = member();
    await assertSucceeds(db.doc(`${WS}/ops/a`).set({ type: 'rename', from: 'a', to: 'b' }));
    await assertFails(db.doc(`${WS}/ops/b`).set({ type: 'wipe' }));
});

test('legacy documents can be read and deleted but not written', async () => {
    const db = member();
    await env.withSecurityRulesDisabled(c => c.firestore().doc(`${WS}/data/main`).set({ issues: [] }));
    await assertSucceeds(db.doc(`${WS}/data/main`).get());
    await assertFails(db.doc(`${WS}/data/main`).set({ issues: [] }));
    await assertSucceeds(db.doc(`${WS}/data/main`).delete());
});

test('concurrent edits to different fields of the same issue both survive', async () => {
    const a = member();
    const b = env.authenticatedContext('u9', { email: MEMBER, email_verified: true }).firestore();
    await issueDoc(a).set(issue());
    await Promise.all([issueDoc(a).update({ status: 'fixed' }), issueDoc(b).update({ milestone: 'Alpha' })]);
    const snap = await issueDoc(a).get();
    assert.equal(snap.data().status, 'fixed');
    assert.equal(snap.data().milestone, 'Alpha');
});

test('anything outside workspaces is locked', async () => {
    await assertFails(member().doc('other/x').set({ a: 1 }));
});
