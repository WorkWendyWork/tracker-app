// Server-side AI categorization so the Gemini key never reaches browsers.
// Deploy:  firebase functions:secrets:set GEMINI_API_KEY
//          firebase deploy --only functions
// Requires the Firebase Blaze (pay-as-you-go) plan.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
// Comma-separated, same emails as firestore.rules (set in functions/.env)
const ALLOWED_EMAILS = defineString('ALLOWED_EMAILS', { default: '' });

const SUBJECTS = ['Gameplay & Balance', 'UI & Navigation', 'Visuals & Juice', 'Technical / Architecture'];

exports.categorize = onCall({ secrets: [GEMINI_API_KEY], maxInstances: 2, timeoutSeconds: 30 }, async (request) => {
    const token = request.auth && request.auth.token;
    if (!token) throw new HttpsError('unauthenticated', 'Sign in first.');
    const allowed = ALLOWED_EMAILS.value().split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (!token.email_verified || !allowed.includes(String(token.email).toLowerCase())) {
        throw new HttpsError('permission-denied', 'Your account is not on the allow-list.');
    }

    const desc = String((request.data && request.data.desc) || '').slice(0, 4000);
    if (desc.length < 5) throw new HttpsError('invalid-argument', 'Description is too short.');

    const prompt = `Analyze this bug report for a video game: "${desc}". \nReturn ONLY a JSON object with two keys: "subject" (choose from: ${SUBJECTS.map(s => `"${s}"`).join(', ')}) and "impact" (choose a number 1 to 4, where 1 is Critical, 2 is High, 3 is Medium, 4 is Low). No markdown or extra text.`;

    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY.value() },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } })
    });
    if (res.status === 429) throw new HttpsError('resource-exhausted', 'AI quota reached, try again later.');
    if (!res.ok) throw new HttpsError('internal', `Gemini request failed (${res.status}).`);

    const data = await res.json();
    let parsed;
    try {
        const text = data.candidates[0].content.parts[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        parsed = JSON.parse(text);
    } catch (e) {
        throw new HttpsError('internal', 'AI returned an unexpected answer.');
    }
    return {
        subject: SUBJECTS.includes(parsed.subject) ? parsed.subject : null,
        impact: ['1', '2', '3', '4'].includes(String(parsed.impact)) ? String(parsed.impact) : null
    };
});
