// Server-side AI suggestions so the Gemini key never reaches browsers.
// Deploy:  firebase functions:secrets:set GEMINI_API_KEY
//          firebase deploy --only functions
// Requires the Firebase Blaze (pay-as-you-go) plan.
//
// Uses the same prompt, parsing and model selection as the app (../lib.js
// is copied in at deploy time by the "predeploy" step in firebase.json).

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { buildCategorizePrompt, parseAiSuggestion, pickGeminiModel, parseAiJson, sanitizeConfig } = require('./lib.js');

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
// Comma-separated, same emails as firestore.rules (set in functions/.env)
const ALLOWED_EMAILS = defineString('ALLOWED_EMAILS', { default: '' });

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
let cachedModel = null;

async function getModel(key, refresh) {
    if (cachedModel && !refresh) return cachedModel;
    const res = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw new HttpsError('internal', `Could not list Gemini models (${res.status}).`);
    cachedModel = pickGeminiModel((await res.json()).models);
    if (!cachedModel) throw new HttpsError('internal', 'No suitable Gemini model available.');
    return cachedModel;
}

exports.categorize = onCall({ secrets: [GEMINI_API_KEY], maxInstances: 2, timeoutSeconds: 30 }, async (request) => {
    const token = request.auth && request.auth.token;
    if (!token) throw new HttpsError('unauthenticated', 'Sign in first.');
    const allowed = ALLOWED_EMAILS.value().split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (!token.email_verified || !allowed.includes(String(token.email).toLowerCase())) {
        throw new HttpsError('permission-denied', 'Your account is not on the allow-list.');
    }

    const data = request.data || {};
    const desc = String(data.desc || '').slice(0, 4000);
    if (desc.trim().length < 5) throw new HttpsError('invalid-argument', 'Description is too short.');
    const cfg = sanitizeConfig({ subjects: data.subjects, milestones: data.milestones });
    const ctx = {
        subjects: cfg.subjects,
        milestones: cfg.milestones,
        tags: (Array.isArray(data.tags) ? data.tags : []).map(t => String(t).slice(0, 30)).slice(0, 100)
    };

    const key = GEMINI_API_KEY.value();
    const body = JSON.stringify({
        contents: [{ parts: [{ text: buildCategorizePrompt(desc, ctx) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    });
    for (let attempt = 0; attempt < 2; attempt++) {
        const model = await getModel(key, attempt > 0);
        const res = await fetch(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body
        });
        if (res.status === 404 && attempt === 0) continue; // model retired: pick another
        if (res.status === 429) throw new HttpsError('resource-exhausted', 'AI quota reached, try again later.');
        if (!res.ok) throw new HttpsError('internal', `Gemini request failed (${res.status}).`);
        const out = await res.json();
        try {
            return parseAiSuggestion(parseAiJson(out.candidates[0].content.parts[0].text), ctx);
        } catch (e) {
            throw new HttpsError('internal', 'AI returned an unexpected answer.');
        }
    }
    throw new HttpsError('internal', 'Gemini model not found.');
});
