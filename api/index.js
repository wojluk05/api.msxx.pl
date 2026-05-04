import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const INDEX_FILE_PATH = join(process.cwd(), 'public', 'index.html');

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(405).json({ error: 'Metoda niedozwolona' });
    }

    try {
        const body = await readFile(INDEX_FILE_PATH);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(req.method === 'HEAD' ? '' : body);
    } catch {
        return res.status(500).json({ error: 'Nie udalo sie zaladowac dashboardu.' });
    }
}