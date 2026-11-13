exports.handler = async () => {
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            success: true,
            hasServerApiKey: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim())
        })
    };
};
