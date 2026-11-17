import { GoogleGenAI } from '@google/genai';

function normalizeRoutine(routine) {
    if (!routine) return 'Daily';
    let r = String(routine).trim();
    // Expand abbreviation variants (both ASCII '0' and Devanagari '०' U+0966)
    r = r.replace(/दै[0०]/g, 'Daily');
    r = r.replace(/सा[0०]/g, 'Weekly');
    return r;
}

function mergeEditions(rows) {
    const seen = new Map();
    const merged = [];

    for (const row of rows) {
        const key = (row.name || '').trim().toUpperCase();

        if (!key) {
            merged.push({ ...row, routine: normalizeRoutine(row.routine) });
            continue;
        }

        const normalizedRow = {
            ...row,
            routine: normalizeRoutine(row.routine)
        };

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

function extractOutputText(interaction) {
    if (interaction.output_text) return interaction.output_text;
    if (interaction.outputText) return interaction.outputText;
    if (interaction.output_json) return JSON.stringify(interaction.output_json);
    if (interaction.outputJson) return JSON.stringify(interaction.outputJson);

    // Fallback: search inside interaction.steps
    if (Array.isArray(interaction.steps)) {
        const texts = [];
        for (const step of interaction.steps) {
            if (step.type === 'model_output' && Array.isArray(step.content)) {
                for (const item of step.content) {
                    if (item.type === 'text' && item.text) {
                        texts.push(item.text);
                    }
                }
            }
        }
        if (texts.length > 0) return texts.join('\n');
    }

    // Fallback: search outputs array
    if (Array.isArray(interaction.outputs)) {
        const texts = [];
        for (const out of interaction.outputs) {
            if (out.text) texts.push(out.text);
            else if (typeof out === 'string') texts.push(out);
        }
        if (texts.length > 0) return texts.join('\n');
    }

    return '';
}

export const handler = async (event) => {
    console.log(`[check-task] Received ${event.httpMethod} request at ${new Date().toISOString()}`);

    const q = event.queryStringParameters || {};
    let id = q.id;
    let apiKey = (q.apiKey && q.apiKey.trim()) || process.env.GEMINI_API_KEY;

    // If sent via POST body fallback
    if (!id && event.body) {
        try {
            const body = JSON.parse(event.body);
            if (body.id) id = body.id;
            if (body.apiKey) apiKey = body.apiKey.trim();
        } catch (_) {}
    }

    if (!id) {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: false, message: 'Missing required "id" parameter' })
        };
    }

    if (!apiKey) {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: false,
                message: 'Gemini API key is required to check task status.'
            })
        };
    }

    try {
        const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1beta' } });
        const interaction = await ai.interactions.get(id, { api_version: 'v1beta' });

        const status = interaction.status || 'in_progress';
        console.log(`[check-task] Interaction "${id}" status: ${status}`);

        // 1. In progress
        if (status === 'in_progress') {
            return {
                statusCode: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store, no-cache, must-revalidate'
                },
                body: JSON.stringify({
                    success: true,
                    status: 'in_progress'
                })
            };
        }

        // 2. Failed or cancelled
        if (status === 'failed' || status === 'cancelled') {
            const errMsg = interaction.error?.message ||
                           (typeof interaction.error === 'string' ? interaction.error : null) ||
                           `Interaction ended with status "${status}"`;
            console.warn(`[check-task] Interaction "${id}" failed: ${errMsg}`);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: false,
                    status: status,
                    error: errMsg
                })
            };
        }

        // 3. Completed
        if (status === 'completed') {
            const rawOutput = extractOutputText(interaction);

            let cleanedText = rawOutput.trim();
            if (cleanedText.startsWith('```json')) cleanedText = cleanedText.slice(7);
            else if (cleanedText.startsWith('```')) cleanedText = cleanedText.slice(3);
            if (cleanedText.endsWith('```')) cleanedText = cleanedText.slice(0, -3);
            cleanedText = cleanedText.trim();

            let parsedRows = [];
            try {
                parsedRows = JSON.parse(cleanedText);
                if (!Array.isArray(parsedRows)) parsedRows = [parsedRows];
            } catch (parseErr) {
                console.error('[check-task] Failed to parse candidate JSON:', rawOutput);
                return {
                    statusCode: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        success: false,
                        status: 'failed',
                        error: 'Failed to parse JSON returned by Gemini: ' + parseErr.message,
                        raw: rawOutput
                    })
                };
            }

            const beforeMerge = parsedRows.length;
            parsedRows = mergeEditions(parsedRows);
            if (parsedRows.length < beforeMerge) {
                console.log(`[check-task] Merged ${beforeMerge - parsedRows.length} duplicate publication(s). Total: ${parsedRows.length}`);
            }

            return {
                statusCode: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store, no-cache, must-revalidate'
                },
                body: JSON.stringify({
                    success: true,
                    status: 'completed',
                    count: parsedRows.length,
                    data: parsedRows
                })
            };
        }

        // Unknown status fallback
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: true,
                status: status
            })
        };

    } catch (err) {
        console.error(`[check-task] Error checking interaction "${id}":`, err);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: false,
                message: err.message || 'Failed to check interaction status'
            })
        };
    }
};
