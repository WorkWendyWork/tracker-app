// Downloads every document under workspaces/ into one JSON file.
// Used by .github/workflows/backup.yml; can also be run locally:
//   GOOGLE_APPLICATION_CREDENTIALS=key.json node scripts/backup.mjs backup.json
import { writeFileSync } from 'node:fs';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const out = process.argv[2] || `backup-${new Date().toISOString().slice(0, 10)}.json`;
initializeApp({ credential: applicationDefault() });
const db = getFirestore();

async function dumpCollection(col) {
    const result = {};
    for (const doc of (await col.get()).docs) {
        const subs = {};
        for (const sub of await doc.ref.listCollections()) subs[sub.id] = await dumpCollection(sub);
        result[doc.id] = { data: doc.data(), ...(Object.keys(subs).length ? { collections: subs } : {}) };
    }
    return result;
}

const backup = { createdAt: new Date().toISOString(), workspaces: await dumpCollection(db.collection('workspaces')) };
writeFileSync(out, JSON.stringify(backup, null, 2));

let count = 0;
JSON.stringify(backup, (k, v) => { if (k === 'issues' && v && typeof v === 'object') count += Object.keys(v).length; return v; });
console.log(`Saved ${out} (${count} issues).`);
