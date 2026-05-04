import { validateHtmlCompatApiKey } from '../lib/webscraping-router.js';
import { applyStreamCorsHeaders, resolveStableStream, sendStreamOptions } from '../lib/remote-stream-router.js';

export default async function handler(req, res) {
    applyStreamCorsHeaders(res);

    if (req.method === 'OPTIONS') {
        return sendStreamOptions(res);
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, code: 'METHOD_NOT_ALLOWED', error: 'Metoda niedozwolona.' });
    }

    const authError = validateHtmlCompatApiKey(req);
    if (authError) {
        return res.status(401).json({ success: false, code: 'INVALID_API_KEY', error: authError.error });
    }

    const result = await resolveStableStream(req);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(result.status).json(result.body);
}