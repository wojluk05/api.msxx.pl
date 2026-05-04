import {
    applyStreamCorsHeaders,
    handleStreamFailure,
    proxyStableStream,
    sendStreamOptions
} from '../lib/remote-stream-router.js';

export default async function handler(req, res) {
    applyStreamCorsHeaders(res);

    if (req.method === 'OPTIONS') {
        return sendStreamOptions(res);
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, code: 'METHOD_NOT_ALLOWED', error: 'Metoda niedozwolona.' });
    }

    try {
        await proxyStableStream(req, res);
    } catch (error) {
        await handleStreamFailure(res, error, req.query?.debug === '1' || req.query?.debug === 'true');
    }
}