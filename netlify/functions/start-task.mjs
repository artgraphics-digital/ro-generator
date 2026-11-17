import { GoogleGenAI } from '@google/genai';

const SKILL_INSTRUCTIONS = `
# Data Extraction Skill

## Purpose and Goals
- Trigger only when the user uses the exact phrase "extract".
- Rapidly extract tabular content from provided images or PDFs starting from the first number found in the first column.
- Keep columns strictly separated—specifically ensuring the 3rd column maps to "routine" and the 4th column maps to "name" without merging.
- Output all extracted values in Hinglish using only English alphabets (Latin script)—transliterating any Hindi/Devanagari text into Romanized Hindi rather than using Devanagari script.
- Expand Hindi periodicity abbreviations:
  - "दै0" or "दै०" (both ASCII and Devanagari zero) must be expanded to "Daily".
  - "सा0" or "सा०" (both ASCII and Devanagari zero) must be expanded to "Weekly".
- Output the extracted data directly in clean JSON format.

## Execution & Rules
1. Trigger Condition: Activate exclusively when the prompt contains the word "extract".
2. Targeted Table Parsing: Locate the main newspaper release table and begin extraction strictly from the row containing the first number found in the first column (skipping preceding headers, preambles, and disclaimers).
3. Strict Column Separation:
   - Map 3rd column strictly to the "routine" field (e.g. Daily, Weekly).
   - Map 4th column strictly to the "name" field (e.g. Publication / Newspaper name).
4. Abbreviation Expansion:
   - Replace "दै0" or "दै०" with "Daily".
   - Replace "सा0" or "सा०" with "Weekly".
5. Hinglish Language & Script Formatting:
   - All extracted JSON values must be in Hinglish using Latin script only. Never output Devanagari script characters.
6. JSON Delivery:
   - Output ONLY a valid JSON array of objects.
`;

const SYSTEM_PROMPT = `You are an expert data extraction assistant specialized in extracting newspaper media release schedules.
Follow the data-extraction skill rules strictly:
${SKILL_INSTRUCTIONS}

EXTRACT EVERY TABULAR ROW representing a newspaper entry into a clean JSON array of objects.
Each object must contain:
- "name": The publication / newspaper name (e.g. "UDETI SAVITA", "DAINIK JAGRAN", "AMAR UJALA").
- "language": The language of publication (e.g. "Hindi", "Urdu", "English"). If not explicitly mentioned, infer from context or default to "Hindi".
- "routine": The frequency / routine details (e.g. "Daily", "Weekly"). Expand "दै0" / "दै०" to "Daily", and "सा0" / "सा०" to "Weekly".
- "edition": The edition or place (e.g. "LUCKNOW + AMBEDKAR NAGAR", "KANPUR"). If not specified or if single place, output the location or leave empty string "".

Output all values in Hinglish using Latin script only (no Devanagari script).
Output ONLY a valid JSON array of objects, starting with [ and ending with ]. Do not wrap in markdown fences or backticks.`;

export const handler = async (event) => {
    // Only allow POST
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: false, message: 'Method Not Allowed' })
        };
    }

    console.log(`[start-task] Received POST request at ${new Date().toISOString()}`);

    let body = {};
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
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: false,
                message: 'Gemini API key is required. Set GEMINI_API_KEY in environment variables or enter it in the web interface.'
            })
        };
    }

    const inputParts = [];

    // Optional PDF attachment
    if (body.pdfBase64) {
        const cleanBase64 = body.pdfBase64.replace(/^data:application\/pdf;base64,/, '').trim();
        inputParts.push({
            type: 'document',
            data: cleanBase64,
            mime_type: 'application/pdf'
        });
    }

    // Text prompt
    const userPromptText = body.text && body.text.trim()
        ? `extract\n${body.text.trim()}`
        : `extract\nExtract all newspaper release entries from the attached document.`;
    inputParts.push({
        type: 'text',
        text: userPromptText
    });

    try {
        const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1beta' } });

        const modelFallbacks = [
            process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
            'gemini-3.5-flash',
            'gemini-3.8-flash'
        ];
        const models = [...new Set(modelFallbacks)];

        let interaction = null;
        let usedModel = null;
        let lastError = null;

        for (const modelName of models) {
            console.log(`[start-task] Trying model "${modelName}" (v1beta)...`);
            try {
                interaction = await ai.interactions.create({
                    model: modelName,
                    api_version: 'v1beta',
                    input: inputParts,
                    system_instruction: SYSTEM_PROMPT,
                    background: true,
                    store: true,
                    response_format: {
                        type: 'text',
                        mime_type: 'application/json'
                    },
                    generation_config: {
                        temperature: 0.1
                    }
                });
                usedModel = modelName;
                break;
            } catch (modelErr) {
                lastError = modelErr;
                const status = modelErr.status || modelErr.httpStatusCode || '';
                console.warn(`[start-task] Model "${modelName}" failed (${status}): ${modelErr.message}`);
                if (status === 401 || status === 403 || status === 429) {
                    console.error(`[start-task] Non-retryable error (${status}), stopping fallback.`);
                    break;
                }
            }
        }

        if (!interaction) {
            throw lastError || new Error('All model fallbacks failed');
        }

        console.log(`[start-task] Background interaction created with "${usedModel}"! ID: ${interaction.id}, Status: ${interaction.status}`);

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store, no-cache, must-revalidate'
            },
            body: JSON.stringify({
                success: true,
                id: interaction.id,
                status: interaction.status || 'in_progress',
                model: usedModel
            })
        };
    } catch (err) {
        console.error('[start-task] Error starting background interaction:', err);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: false,
                message: err.message || 'Failed to start Gemini background interaction'
            })
        };
    }
};
