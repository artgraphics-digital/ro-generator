exports.handler = async () => {
    const rawKey = process.env.GEMINI_API_KEY || '';
    const hasKey = Boolean(rawKey && rawKey.trim().length > 0);
    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, no-cache, must-revalidate'
        },
        body: JSON.stringify({
            success: true,
            hasServerApiKey: hasKey,
            keyConfigured: hasKey
        })
    };
};

