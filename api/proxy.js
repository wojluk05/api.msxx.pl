import { forwardWebScrapingRequest, queueBackgroundRefresh, validateAppPassword } from '../lib/webscraping-router.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Metoda niedozwolona' });
    }

    const authError = validateAppPassword(req);
    if (authError) {
        return res.status(401).json(authError);
    }

    const result = await forwardWebScrapingRequest(req.body);

    if (result.selectedKey) {
        res.setHeader('x-router-key', result.selectedKey.envName);
        res.setHeader('x-router-key-label', result.selectedKey.label);
        res.setHeader('x-router-provider', 'webscrapingai');
        res.setHeader('x-router-strategy', 'highest_remaining_api_calls');
        res.setHeader('x-router-forced-proxy', 'residential');
        res.setHeader('x-router-forced-js', 'true');
    }

    Object.entries(result.headers || {}).forEach(([name, value]) => {
        if (value) {
            res.setHeader(name, value);
        }
    });

    res.status(result.status).send(result.body);
    queueBackgroundRefresh();
}