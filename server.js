const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const BASE_DIR = __dirname;

// Load environment variables from .env file if present
function loadEnv() {
    const envPath = path.join(BASE_DIR, '.env');
    if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx !== -1) {
                const key = trimmed.slice(0, eqIdx).trim();
                const val = trimmed.slice(eqIdx + 1).trim();
                if (!process.env[key] && val) {
                    process.env[key] = val;
                }
            }
        }
    }
}
loadEnv();

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.pdf': 'application/pdf',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml'
};

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 60 * 1024 * 1024) { // 60MB limit
                reject(new Error('Payload too large'));
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

// Native HTTPS helpers (avoids undici default 30s HeadersTimeoutError)
function httpsGet(urlStr) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const req = https.request({
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: 'GET',
            timeout: 120000
        }, res => {
            let resBody = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { resBody += chunk; });
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    text: () => Promise.resolve(resBody),
                    json: () => Promise.resolve(JSON.parse(resBody))
                });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('GET request timed out')));
        req.end();
    });
}

function httpsPost(urlStr, data) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const postData = JSON.stringify(data);
        const req = https.request({
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 300000 // 5-minute timeout for large PDF OCR
        }, res => {
            let resBody = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { resBody += chunk; });
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    text: () => Promise.resolve(resBody),
                    json: () => Promise.resolve(JSON.parse(resBody))
                });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Gemini API request timed out after 5 minutes')));
        req.write(postData);
        req.end();
    });
}

function getSkillContent() {
    const skillPath = path.join(BASE_DIR, '.agents', 'skills', 'data-extraction', 'SKILL.md');
    if (fs.existsSync(skillPath)) {
        return fs.readFileSync(skillPath, 'utf8');
    }
    return '';
}

let cachedModel = null;
async function resolveWorkingModel(apiKey) {
    if (process.env.GEMINI_MODEL) {
        return process.env.GEMINI_MODEL;
    }
    if (cachedModel) return cachedModel;

    try {
        console.log('[Gemini] Querying available models from Google AI Studio...');
        const listRes = await httpsGet(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
        if (listRes.ok) {
            const listData = await listRes.json();
            const models = (listData.models || []).map(m => m.name.replace(/^models\//, ''));
            console.log('[Gemini] Models available for key:', models.filter(m => m.includes('flash') || m.includes('gemini')));

            const preferred = ['gemini-3.6-flash'];

            for (const p of preferred) {
                if (models.includes(p)) {
                    console.log(`[Gemini] Selected optimal model: ${p}`);
                    cachedModel = p;
                    return p;
                }
            }

            const anyFlash = models.find(m => m.includes('flash'));
            if (anyFlash) {
                console.log(`[Gemini] Selected flash model: ${anyFlash}`);
                cachedModel = anyFlash;
                return anyFlash;
            }
        } else {
            console.warn('[Gemini] Models list returned status:', listRes.status);
        }
    } catch (e) {
        console.warn('[Gemini] Could not list models:', e.message);
    }

    return 'gemini-3.6-flash';
}

/**
 * Merges rows that share the same publication name by combining their editions,
 * languages, and routines using ' + ' as a separator for any differing values.
 *
 * Matching key: trimmed, uppercased publication name only.
 *
 * Example:
 *   { name: "TIMES OF INDIA", language: "English", routine: "Daily", edition: "LUCKNOW" }
 *   { name: "TIMES OF INDIA", language: "English", routine: "Daily", edition: "DELHI" }
 *   → { name: "TIMES OF INDIA", language: "English", routine: "Daily", edition: "LUCKNOW + DELHI" }
 */
function normalizeRoutine(routine) {
    if (!routine) return 'Daily';
    let r = String(routine).trim();
    r = r.replace(/दै[0०]/g, 'Daily');
    r = r.replace(/सा[0०]/g, 'Weekly');
    return r;
}

function mergeEditions(rows) {
    const seen = new Map();   // normalized-name → index in `merged`
    const merged = [];

    for (const row of rows) {
        const key = (row.name || '').trim().toUpperCase();

        if (!key) {
            // Unnamed row — keep as-is, no merge
            merged.push({ ...row, routine: normalizeRoutine(row.routine) });
            continue;
        }

        const normalizedRow = {
            ...row,
            routine: normalizeRoutine(row.routine)
        };

        if (seen.has(key)) {
            const existing = merged[seen.get(key)];

            // Helper: append a new token to an existing field if it isn't already present
            function mergeField(existingVal, newVal) {
                const prev = (existingVal || '').trim();
                const next = (newVal || '').trim();
                if (!next || prev === next) return prev;
                // Avoid duplicating tokens already in the string
                const tokens = prev.split('+').map(t => t.trim());
                if (tokens.includes(next)) return prev;
                return prev ? `${prev} + ${next}` : next;
            }

            existing.edition = mergeField(existing.edition, normalizedRow.edition);
            existing.language = mergeField(existing.language, normalizedRow.language);
            existing.routine = mergeField(existing.routine, normalizedRow.routine);
        } else {
            seen.set(key, merged.length);
            merged.push(normalizedRow);
        }
    }

    return merged;
}

const server = http.createServer(async (req, res) => {
    // Set permissive CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    let parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(parsedUrl.pathname);

    // ==================== API ROUTE: CONFIG ====================
    if (pathname === '/api/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            hasServerApiKey: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim())
        }));
        return;
    }

    // ==================== API ROUTE: START-TASK (ASYNC INTERACTIONS API) ====================
    if (pathname === '/api/start-task' && req.method === 'POST') {
        console.log(`\n[${new Date().toLocaleTimeString()}] ---> Received POST /api/start-task`);
        try {
            const body = await readBody(req);
            const apiKey = (body.apiKey && body.apiKey.trim()) || process.env.GEMINI_API_KEY;

            if (!apiKey) {
                console.warn('[API] Missing API key for start-task');
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    message: 'Gemini API key is required. Set it in .env or enter it in the web interface.'
                }));
                return;
            }

            const inputParts = [];
            if (body.pdfBase64) {
                const cleanBase64 = body.pdfBase64.replace(/^data:application\/pdf;base64,/, '').trim();
                inputParts.push({
                    type: 'document',
                    data: cleanBase64,
                    mime_type: 'application/pdf'
                });
            }

            const userPromptText = body.text && body.text.trim()
                ? `extract\n${body.text.trim()}`
                : `extract\nExtract all newspaper release entries from the attached document.`;
            inputParts.push({
                type: 'text',
                text: userPromptText
            });

            const skillInstructions = getSkillContent();
            const systemPrompt = `You are an expert data extraction assistant specialized in extracting newspaper media release schedules.
Follow the data-extraction skill rules strictly:
${skillInstructions}

EXTRACT EVERY TABULAR ROW representing a newspaper entry into a clean JSON array of objects.
Each object must contain:
- "name": The publication / newspaper name (e.g. "UDETI SAVITA", "DAINIK JAGRAN", "AMAR UJALA").
- "language": The language of publication (e.g. "Hindi", "Urdu", "English"). If not explicitly mentioned, infer from context or default to "Hindi".
- "routine": The frequency / routine details (e.g. "Daily", "Weekly"). Expand "दै0" / "दै०" to "Daily", and "सा0" / "सा०" to "Weekly".
- "edition": The edition or place (e.g. "LUCKNOW + AMBEDKAR NAGAR", "KANPUR"). If not specified or if single place, output the location or leave empty string "".

Output all values in Hinglish using Latin script only (no Devanagari script).
Output ONLY a valid JSON array of objects, starting with [ and ending with ]. Do not wrap in markdown fences or backticks.`;

            const ai = new GoogleGenAI({ apiKey });
            const modelName = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
            console.log(`[API] Creating background interaction with model "${modelName}"...`);

            const interaction = await ai.interactions.create({
                model: modelName,
                input: inputParts,
                system_instruction: systemPrompt,
                background: true,
                store: true,
                generation_config: {
                    response_mime_type: 'application/json',
                    temperature: 0.1
                }
            });

            console.log(`[API] Background task created! ID: ${interaction.id}, Status: ${interaction.status}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                id: interaction.id,
                status: interaction.status || 'in_progress'
            }));
            return;

        } catch (err) {
            console.error('[API] start-task error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: err.message || 'Failed to start Gemini background interaction'
            }));
            return;
        }
    }

    // ==================== API ROUTE: CHECK-TASK (ASYNC STATUS POLLING) ====================
    if (pathname === '/api/check-task' && (req.method === 'GET' || req.method === 'POST')) {
        try {
            let id = parsedUrl.searchParams.get('id');
            let apiKey = (parsedUrl.searchParams.get('apiKey') && parsedUrl.searchParams.get('apiKey').trim()) || process.env.GEMINI_API_KEY;

            if (!id && req.method === 'POST') {
                const body = await readBody(req);
                if (body.id) id = body.id;
                if (body.apiKey) apiKey = body.apiKey.trim();
            }

            if (!id) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Missing required "id" parameter' }));
                return;
            }

            if (!apiKey) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Gemini API key is required to check task' }));
                return;
            }

            const ai = new GoogleGenAI({ apiKey });
            const interaction = await ai.interactions.get(id);
            const status = interaction.status || 'in_progress';
            console.log(`[API] Check-task "${id}" status: ${status}`);

            if (status === 'in_progress') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, status: 'in_progress' }));
                return;
            }

            if (status === 'failed' || status === 'cancelled') {
                const errMsg = interaction.error?.message ||
                               (typeof interaction.error === 'string' ? interaction.error : null) ||
                               `Interaction ended with status "${status}"`;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, status, error: errMsg }));
                return;
            }

            if (status === 'completed') {
                let rawOutput = interaction.output_text || interaction.outputText || '';
                if (!rawOutput && Array.isArray(interaction.steps)) {
                    const texts = [];
                    for (const step of interaction.steps) {
                        if (step.type === 'model_output' && Array.isArray(step.content)) {
                            for (const item of step.content) {
                                if (item.type === 'text' && item.text) texts.push(item.text);
                            }
                        }
                    }
                    if (texts.length > 0) rawOutput = texts.join('\n');
                }

                let cleanedText = (rawOutput || '').trim();
                if (cleanedText.startsWith('```json')) cleanedText = cleanedText.slice(7);
                else if (cleanedText.startsWith('```')) cleanedText = cleanedText.slice(3);
                if (cleanedText.endsWith('```')) cleanedText = cleanedText.slice(0, -3);
                cleanedText = cleanedText.trim();

                let parsedRows = [];
                try {
                    parsedRows = JSON.parse(cleanedText);
                    if (!Array.isArray(parsedRows)) parsedRows = [parsedRows];
                } catch (parseErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        status: 'failed',
                        error: 'Failed to parse JSON returned by Gemini: ' + parseErr.message,
                        raw: rawOutput
                    }));
                    return;
                }

                const beforeMerge = parsedRows.length;
                parsedRows = mergeEditions(parsedRows);
                if (parsedRows.length < beforeMerge) {
                    console.log(`[API] Merged ${beforeMerge - parsedRows.length} duplicate publication(s). Total: ${parsedRows.length}`);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    status: 'completed',
                    count: parsedRows.length,
                    data: parsedRows
                }));
                return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, status }));
            return;

        } catch (err) {
            console.error('[API] check-task error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: err.message || 'Failed to check interaction status'
            }));
            return;
        }
    }

    // ==================== API ROUTE: EXTRACT ====================
    if (pathname === '/api/extract' && req.method === 'POST') {
        console.log(`\n[${new Date().toLocaleTimeString()}] ---> Received POST /api/extract request`);
        try {
            const body = await readBody(req);
            const apiKey = (body.apiKey && body.apiKey.trim()) || process.env.GEMINI_API_KEY;

            if (!apiKey) {
                console.warn('[API] Missing API key');
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    message: 'Gemini API key is required. Set it in .env or enter it in the web interface.'
                }));
                return;
            }

            console.log(`[API] Payload details: Has PDF: ${Boolean(body.pdfBase64)}, Has Text: ${Boolean(body.text)}`);

            const skillInstructions = getSkillContent();
            const systemPrompt = `You are an expert data extraction assistant specialized in extracting newspaper media release schedules.
Follow the data-extraction skill rules strictly:
${skillInstructions}

EXTRACT EVERY TABULAR ROW representing a newspaper entry into a clean JSON array of objects.
Each object must contain:
- "name": The publication / newspaper name (e.g. "UDETI SAVITA", "DAINIK JAGRAN", "AMAR UJALA").
- "language": The language of publication (e.g. "Hindi", "Urdu", "English"). If not explicitly mentioned, infer from context or default to "Hindi".
- "routine": The frequency / routine details (e.g. "Daily", "Weekly").
- "edition": The edition or place (e.g. "LUCKNOW + AMBEDKAR NAGAR", "KANPUR"). If not specified or if single place, output the location or leave empty string "".

Output all values in Hinglish using Latin script only (no Devanagari script).
Output ONLY a valid JSON array of objects, starting with [ and ending with ]. Do not wrap in markdown or backticks.`;

            const parts = [];
            if (body.pdfBase64) {
                const cleanBase64 = body.pdfBase64.replace(/^data:application\/pdf;base64,/, '').trim();
                parts.push({
                    inline_data: {
                        mime_type: 'application/pdf',
                        data: cleanBase64
                    }
                });
            }

            const userPromptText = body.text ?
                `extract\n${body.text}` :
                `extract\nExtract all newspaper release entries from the attached document.`;

            parts.push({ text: userPromptText });

            const candidateModels = [
                'gemini-2.5-flash',
                'gemini-2.0-flash',
                'gemini-1.5-flash',
                'gemini-4-hydrogen',
                'gemini-3.6-flash'
            ];

            let geminiRes = null;
            let lastErrText = '';
            let successfulModel = '';

            for (const m of candidateModels) {
                console.log(`[Gemini] Trying model "${m}"...`);
                const startTime = Date.now();
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(apiKey)}`;

                try {
                    const res = await httpsPost(geminiUrl, {
                        system_instruction: { parts: [{ text: systemPrompt }] },
                        contents: [{ parts: parts }],
                        generationConfig: { response_mime_type: 'application/json', temperature: 0.1 }
                    });

                    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
                    console.log(`[Gemini] Model "${m}" responded with status ${res.status} in ${elapsedSec}s`);

                    if (res.ok) {
                        geminiRes = res;
                        successfulModel = m;
                        break;
                    }

                    lastErrText = await res.text();
                    console.warn(`[Gemini] Model "${m}" error (${res.status}): ${lastErrText}. Trying fallback...`);

                    // If temporary overload (503) or rate-limit (429) or not found (404), try next model
                    if (res.status === 503 || res.status === 429 || res.status === 404) {
                        continue;
                    } else {
                        break;
                    }
                } catch (netErr) {
                    console.warn(`[Gemini] Network error with "${m}": ${netErr.message}`);
                    lastErrText = netErr.message;
                }
            }

            if (!geminiRes || !geminiRes.ok) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    message: `Gemini API error: ${lastErrText}`
                }));
                return;
            }

            console.log(`[Gemini] Success using model "${successfulModel}"! Parsing JSON...`);

            const geminiData = await geminiRes.json();
            const candidateText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

            let cleanedText = candidateText.trim();
            if (cleanedText.startsWith('```json')) {
                cleanedText = cleanedText.slice(7);
            } else if (cleanedText.startsWith('```')) {
                cleanedText = cleanedText.slice(3);
            }
            if (cleanedText.endsWith('```')) {
                cleanedText = cleanedText.slice(0, -3);
            }
            cleanedText = cleanedText.trim();

            let parsedRows = [];
            try {
                parsedRows = JSON.parse(cleanedText);
                if (!Array.isArray(parsedRows)) {
                    parsedRows = [parsedRows];
                }
            } catch (pErr) {
                console.error('[API] Failed to parse candidate JSON:', candidateText);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    message: 'Failed to parse JSON returned by Gemini: ' + pErr.message,
                    raw: candidateText
                }));
                return;
            }

            // Merge rows that share the same publication name but differ in edition/language/routine
            const beforeMerge = parsedRows.length;
            parsedRows = mergeEditions(parsedRows);
            if (parsedRows.length < beforeMerge) {
                console.log(`[API] Merged ${beforeMerge - parsedRows.length} duplicate publication(s). Rows: ${beforeMerge} → ${parsedRows.length}`);
            }

            console.log(`[API] Successfully parsed ${parsedRows.length} newspaper rows!`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                count: parsedRows.length,
                data: parsedRows
            }));
            return;

        } catch (error) {
            console.error('[API] Extraction error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: error.message || 'Internal extraction error'
            }));
            return;
        }
    }

    // ==================== STATIC FILE SERVING ====================
    if (pathname === '/' || pathname === '') {
        pathname = '/index.html';
    }
    let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(BASE_DIR, safePath);

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`404 Not Found: ${safePath}`);
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stats.size,
            'Cache-Control': 'no-cache'
        });

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`Serving files from ${BASE_DIR}`);
});
