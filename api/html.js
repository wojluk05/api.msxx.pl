import {
    forwardHtmlCompatRequest,
    queueBackgroundRefresh,
    validateHtmlCompatApiKey
} from '../lib/webscraping-router.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Metoda niedozwolona' });
    }

    const authError = validateHtmlCompatApiKey(req);
    if (authError) {
        return res.status(401).json(authError);
    }

    const result = await forwardHtmlCompatRequest(req.query || {});

    Object.entries(result.headers || {}).forEach(([name, value]) => {
        if (value) {
            res.setHeader(name, value);
        }
    });

    res.status(result.status).send(result.body);
    queueBackgroundRefresh();
}