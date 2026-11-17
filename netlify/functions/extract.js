const https = require('https');

// ─── HTTPS helpers ────────────────────────────────────────────────────────────

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
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({
                status: res.statusCode,
                ok: res.statusCode >= 200 && res.statusCode < 300,
                text: () => Promise.resolve(body),
                json: () => Promise.resolve(JSON.parse(body))
            }));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('GET timed out')));
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
            timeout: 300000   // 5-minute timeout for large PDF OCR
        }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({
                status: res.statusCode,
                ok: res.statusCode >= 200 && res.statusCode < 300,
                text: () => Promise.resolve(body),
                json: () => Promise.resolve(JSON.parse(body))
            }));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Gemini API request timed out after 5 minutes')));
        req.write(postData);
        req.end();
    });
}

// ─── Edition merger ───────────────────────────────────────────────────────────

function mergeEditions(rows) {
    const seen = new Map();
    const merged = [];

    for (const row of rows) {
        const key = (row.name || '').trim().toUpperCase();

        if (!key) {
            merged.push({ ...row });
            continue;
        }

        if (seen.has(key)) {
            const existing = merged[seen.get(key)];

            function mergeField(existingVal, newVal) {
                const prev = (existingVal || '').trim();
                const next = (newVal || '').trim();
                if (!next || prev === next) return prev;
                const tokens = prev.split('+').map(t => t.trim());
                if (tokens.includes(next)) return prev;
                return prev ? `${prev} + ${next}` : next;
            }

            existing.edition  = mergeField(existing.edition,  row.edition);
            existing.language = mergeField(existing.language, row.language);
            existing.routine  = mergeField(existing.routine,  row.routine);
        } else {
            seen.set(key, merged.length);
            merged.push({ ...row });
        }
    }

    return merged;
}

// ─── Skill instructions (inlined — no filesystem access on Netlify) ───────────

const SKILL_INSTRUCTIONS = `
# Data Extraction Skill

## Purpose and Goals

- Trigger **only** when the user uses the exact phrase **"extract"**.
- Rapidly extract tabular content from provided images or PDFs starting from the first number found in the first column.
- Keep columns strictly separated—specifically ensuring the 3rd column maps to \`routine\` and the 4th column maps to \`name\` without merging.
- Output all extracted values in **Hinglish** using **only English alphabets (Latin script)**—transliterating any Hindi/Devanagari text into Romanized Hindi rather than using Devanagari script.
- Expand Hindi periodicity abbreviations (\`दै0\` as \`Daily\` and \`सा0\` as \`Weekly\`).
- Output the extracted data directly in clean **JSON** format.

## Optimized Execution & Rules

1. **Trigger Condition:** Activate this skill **exclusively** when the user's prompt contains the exact phrase \`"extract"\`.
2. **Targeted Table Parsing (Start at First Number in Column 1):**
   - Locate the main data table and begin extraction strictly from the row containing the **first number found in the first column** (skipping all preceding headers, preambles, boilerplate text, or legal disclaimers).
3. **Strict Column Separation (\`routine\` and \`name\`):**
   - Never merge values from adjacent columns into a single field.
   - Map the **3rd column** strictly to the \`"routine"\` field.
   - Map the **4th column** strictly to the \`"name"\` field.
4. **Abbreviation Expansion:**
   - Replace/address \`दै0\` (or \`दै०\`) as \`"Daily"\`.
   - Replace/address \`सा0\` (or \`सा०\`) as \`"Weekly"\`.
5. **Hinglish Language & Script Formatting:**
   - All extracted JSON values must be written in **Hinglish** using **only English alphabets (Latin script)**.
   - Transliterate any remaining Hindi/Devanagari text into standard Romanized Hindi, and never output Devanagari or other non-Latin characters.
6. **Delivery (JSON Output):**
   - Output the extracted tabular data directly in a clean, structured **JSON** block in the response.
`;

// ─── Netlify Function handler ─────────────────────────────────────────────────

exports.handler = async (event) => {
    // Only allow POST
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, message: 'Method Not Allowed' }) };
    }

    console.log(`[${new Date().toLocaleTimeString()}] ---> Received POST /api/extract`);

    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch (e) {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: false, message: 'Invalid JSON body' })
        };
    }

    const apiKey = (body.apiKey && body.apiKey.trim()) || process.env.GEMINI_API_KEY;

    if (!apiKey) {
        console.warn('[API] Missing API key');
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: false,
                message: 'Gemini API key is required. Set GEMINI_API_KEY in Netlify environment variables or enter it in the web interface.'
            })
        };
    }

    console.log(`[API] Payload: Has PDF: ${Boolean(body.pdfBase64)}, Has Text: ${Boolean(body.text)}`);

    const systemPrompt = `You are an expert data extraction assistant specialized in extracting newspaper media release schedules.
Follow the data-extraction skill rules strictly:
${SKILL_INSTRUCTIONS}

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

    const userPromptText = body.text
        ? `extract\n${body.text}`
        : `extract\nExtract all newspaper release entries from the attached document.`;
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
            const r = await httpsPost(geminiUrl, {
                system_instruction: { parts: [{ text: systemPrompt }] },
                contents: [{ parts }],
                generationConfig: { response_mime_type: 'application/json', temperature: 0.1 }
            });

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`[Gemini] Model "${m}" responded with status ${r.status} in ${elapsed}s`);

            if (r.ok) {
                geminiRes = r;
                successfulModel = m;
                break;
            }

            lastErrText = await r.text();
            console.warn(`[Gemini] Model "${m}" error (${r.status}): ${lastErrText}. Trying fallback...`);

            if (r.status === 503 || r.status === 429 || r.status === 404) {
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
        return {
            statusCode: 503,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: false, message: `Gemini API error: ${lastErrText}` })
        };
    }

    console.log(`[Gemini] Success using model "${successfulModel}"! Parsing JSON...`);

    const geminiData = await geminiRes.json();
    const candidateText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

    let cleanedText = candidateText.trim();
    if (cleanedText.startsWith('```json')) cleanedText = cleanedText.slice(7);
    else if (cleanedText.startsWith('```')) cleanedText = cleanedText.slice(3);
    if (cleanedText.endsWith('```')) cleanedText = cleanedText.slice(0, -3);
    cleanedText = cleanedText.trim();

    let parsedRows = [];
    try {
        parsedRows = JSON.parse(cleanedText);
        if (!Array.isArray(parsedRows)) parsedRows = [parsedRows];
    } catch (pErr) {
        console.error('[API] Failed to parse candidate JSON:', candidateText);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: false,
                message: 'Failed to parse JSON returned by Gemini: ' + pErr.message,
                raw: candidateText
            })
        };
    }

    const beforeMerge = parsedRows.length;
    parsedRows = mergeEditions(parsedRows);
    if (parsedRows.length < beforeMerge) {
        console.log(`[API] Merged ${beforeMerge - parsedRows.length} duplicate publication(s). Rows: ${beforeMerge} → ${parsedRows.length}`);
    }

    console.log(`[API] Successfully parsed ${parsedRows.length} newspaper rows!`);
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, count: parsedRows.length, data: parsedRows })
    };
};
