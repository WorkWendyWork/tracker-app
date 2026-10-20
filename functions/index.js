// Server-side AI so the Gemini key never reaches browsers.
// Deploy:  firebase functions:secrets:set GEMINI_API_KEY
//          firebase deploy --only functions
// Requires the Firebase Blaze (pay-as-you-go) plan.
//
// Uses the same prompts, parsing and model selection as the app (../lib.js
// is copied in at deploy time by the "predeploy" step in firebase.json).

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const {
    buildCategorizePrompt, parseAiSuggestion, pickGeminiModel, parseAiJson, sanitizeConfig,
    buildTaxonomyPrompt, parseTaxonomy, buildAssignPrompt, parseAssignments, ORGANIZE_BATCH, ORGANIZE_SAMPLE,
    buildFillPrompt, parseFillResults, FILL_BATCH
} = require('./lib.js');

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
// Comma-separated, same emails as firestore.rules (set in functions/.env)
const ALLOWED_EMAILS = defineString('ALLOWED_EMAILS', { default: '' });

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
let cachedModel = null;

function requireTeamMember(request) {
    const token = request.auth && request.auth.token;
    if (!token) throw new HttpsError('unauthenticated', 'Sign in first.');
    const allowed = ALLOWED_EMAILS.value().split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (!token.email_verified || !allowed.includes(String(token.email).toLowerCase())) {
        throw new HttpsError('permission-denied', 'Your account is not on the allow-list.');
    }
}

async function getModel(key, refresh) {
    if (cachedModel && !refresh) return cachedModel;
    const res = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw new HttpsError('internal', `Could not list Gemini models (${res.status}).`);
    cachedModel = pickGeminiModel((await res.json()).models);
    if (!cachedModel) throw new HttpsError('internal', 'No suitable Gemini model available.');
    return cachedModel;
}

// Sends a prompt, returns the parsed JSON answer. Re-picks the model if it was retired.
async function askGemini(prompt) {
    const key = GEMINI_API_KEY.value();
    const body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    });
    for (let attempt = 0; attempt < 2; attempt++) {
        const model = await getModel(key, attempt > 0);
        const res = await fetch(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body
        });
        if (res.status === 404 && attempt === 0) continue;
        if (res.status === 429) throw new HttpsError('resource-exhausted', 'AI quota reached, try again later.');
        if (!res.ok) throw new HttpsError('internal', `Gemini request failed (${res.status}).`);
        const out = await res.json();
        try {
            return parseAiJson(out.candidates[0].content.parts[0].text);
        } catch (e) {
            throw new HttpsError('internal', 'AI returned an unexpected answer.');
        }
    }
    throw new HttpsError('internal', 'Gemini model not found.');
}

const cleanTags = (tags) => (Array.isArray(tags) ? tags : []).map(t => String(t).slice(0, 30)).slice(0, 150);
const cleanItems = (items, max) => (Array.isArray(items) ? items : []).slice(0, max)
    .map(it => ({ i: Number(it && it.i) || 0, text: String((it && it.text) || '').slice(0, 400) }));

// ✨ AI Category: suggestion for one bug
exports.categorize = onCall({ secrets: [GEMINI_API_KEY], maxInstances: 2, timeoutSeconds: 30 }, async (request) => {
    requireTeamMember(request);
    const data = request.data || {};
    const desc = String(data.desc || '').slice(0, 4000);
    if (desc.trim().length < 5) throw new HttpsError('invalid-argument', 'Description is too short.');
    const cfg = sanitizeConfig({ subjects: data.subjects, milestones: data.milestones });
    const ctx = { subjects: cfg.subjects, milestones: cfg.milestones, tags: cleanTags(data.tags) };
    return parseAiSuggestion(await askGemini(buildCategorizePrompt(desc, ctx)), ctx);
});

// 🤖 Reorganize with AI: step "taxonomy" proposes subjects, step "assign" sorts a batch of bugs
exports.organize = onCall({ secrets: [GEMINI_API_KEY], maxInstances: 2, timeoutSeconds: 120 }, async (request) => {
    requireTeamMember(request);
    const data = request.data || {};
    const subjects = sanitizeConfig({ subjects: data.subjects }).subjects;
    if (data.step === 'taxonomy') {
        const items = cleanItems(data.items, ORGANIZE_SAMPLE);
        if (items.length < 2) throw new HttpsError('invalid-argument', 'Not enough bugs.');
        return { subjects: parseTaxonomy(await askGemini(buildTaxonomyPrompt(items, subjects))) };
    }
    if (data.step === 'assign') {
        const items = cleanItems(data.items, ORGANIZE_BATCH);
        const tags = cleanTags(data.tags);
        const map = parseAssignments(await askGemini(buildAssignPrompt(items, subjects, tags)), items.map(it => it.i), subjects, tags);
        return { assignments: [...map].map(([i, a]) => ({ i, subject: a.subject, tags: a.tags })) };
    }
    if (data.step === 'fill') {
        const items = cleanItems(data.items, FILL_BATCH);
        const cfg = sanitizeConfig({ subjects: data.subjects, milestones: data.milestones });
        const ctx = { subjects: cfg.subjects, milestones: cfg.milestones, tags: cleanTags(data.tags) };
        const map = parseFillResults(await askGemini(buildFillPrompt(items, ctx)), items.map(it => it.i), ctx);
        return { results: [...map].map(([i, s]) => ({ i, ...s })) };
    }
    throw new HttpsError('invalid-argument', 'Unknown step.');
});
