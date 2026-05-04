import {
    buildStatusResponse,
    ensureFreshStatuses,
    getCachedStatuses,
    refreshAllKeyStatuses,
    validateAppPassword
} from '../lib/webscraping-router.js';

export default async function handler(req, res) {
    const authError = validateAppPassword(req);
    if (authError) {
        return res.status(401).json(authError);
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Metoda niedozwolona' });
    }

    const shouldForceRefresh = req.method === 'POST' || req.query?.refresh === '1';
    const statuses = shouldForceRefresh
        ? await refreshAllKeyStatuses({ force: true })
        : await ensureFreshStatuses();

    return res.status(200).json(buildStatusResponse(statuses || getCachedStatuses()));
}