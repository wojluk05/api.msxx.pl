import { extractSourcesFromHtml, extractSearchResults } from './lib/scraper-extractors.js';
import { detectCloudflareChallenge } from './lib/scraper-cloudflare.js';
import {
    buildStatusResponse,
    ensureFreshStatuses,
    getCachedStatuses,
    refreshAllKeyStatuses,
    queueBackgroundRefresh,
    forwardHtmlCompatRequest
} from './lib/webscraping-router.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const express = require('express');
const cors = require('cors');

const app = express();

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || process.env.SCRAPER_PORT || 8787);
const API_KEY = String(process.env.SELF_SCRAPER_API_KEY || '').trim().replace(/^["']+|["']+$/g, '');

app.use(cors());
app.use(express.json({ limit: '2mb' }));

function parseBoolean(value, fallbackValue = false) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return Boolean(fallbackValue);
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return Boolean(fallbackValue);
}

function toPositiveInt(value, fallbackValue, minValue = 1) {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isInteger(parsed) || parsed < minValue) return fallbackValue;
    return parsed;
}

function getFirstQueryValue(value) {
    return Array.isArray(value) ? value[0] : value;
}

function normalizeHttpUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        if (!/^https?:$/i.test(parsed.protocol)) return '';
        return parsed.toString();
    } catch {
        return '';
    }
}

function requireApiKey(req, res, next) {
    if (!API_KEY) {
        next();
        return;
    }

    const fromQuery = String(getFirstQueryValue(req.query.api_key) || '').trim().replace(/^["']+|["']+$/g, '');
    const fromHeader = String(req.headers['x-api-key'] || '').trim().replace(/^["']+|["']+$/g, '');

    if (fromQuery === API_KEY || fromHeader === API_KEY) {
        next();
        return;
    }

    res.status(401).json({ ok: false, error: 'Invalid API key' });
}

function getAutoSessionKey(targetUrl) {
    try {
        return new URL(targetUrl).hostname;
    } catch {
        return '';
    }
}

function hasWebscrapingKeys() {
    const packed = String(process.env.WEBSCRAPINGAI_KEYS || '').trim();
    if (packed) return true;
    return Object.keys(process.env).some(
        (key) => key.startsWith('WEBSCRAPINGAI_KEY_') && process.env[key]
    );
}

async function fetchHtmlWithFallback(targetUrl, options = {}) {
    if (!hasWebscrapingKeys()) {
        throw new Error('No scraping service configured (set WEBSCRAPINGAI_KEY_*)');
    }

    const wsaiTimeoutMs = Math.min(toPositiveInt(options.timeoutMs, 30000, 5000), 30000);
    const useJs = options.render !== false;

    const buildQuery = (withSelector) => {
        const q = {
            url: targetUrl,
            js: useJs ? 1 : 0,
            proxy: 'residential',
            timeout: wsaiTimeoutMs
        };
        if (withSelector && options.waitForSelector) {
            q.wait_for = options.waitForSelector;
        }
        return q;
    };

    let result = await forwardHtmlCompatRequest(buildQuery(true));

    if (!result.ok && result.status >= 500) {
        console.warn(`[wsai] ${targetUrl} → HTTP ${result.status} with wait_for, retrying without...`);
        result = await forwardHtmlCompatRequest(buildQuery(false));
    }

    const html = result.body ? result.body.toString('utf8') : '';

    if (!result.ok && result.status >= 500) {
        const bodySnippet = html.slice(0, 300);
        console.error(`[wsai] ${targetUrl} → HTTP ${result.status}: ${bodySnippet}`);
        throw new Error(`WebscrapingAI HTTP ${result.status}${bodySnippet ? `: ${bodySnippet}` : ''}`);
    }

    const blocked = detectCloudflareChallenge(html, targetUrl);

    return {
        ok: !blocked && result.ok,
        blocked,
        strategy: 'webscraping-ai',
        html,
        finalUrl: targetUrl,
        status: result.status,
        trace: [{ strategy: 'webscraping-ai', blocked }],
        errors: []
    };
}

app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        service: 'scraper-server',
        sessions: 0,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/keys/status', requireApiKey, async (req, res) => {
    const shouldForce = req.query.refresh === '1';
    const statuses = shouldForce
        ? await refreshAllKeyStatuses({ force: true })
        : await ensureFreshStatuses();
    res.json(buildStatusResponse(statuses || getCachedStatuses()));
    queueBackgroundRefresh();
});

app.get('/api/debug-wsai', requireApiKey, async (req, res) => {
    const targetUrl = normalizeHttpUrl(String(req.query.url || 'https://zaluknij.cc/'));
    if (!targetUrl) {
        res.status(400).json({ ok: false, error: 'Missing url' });
        return;
    }

    const rawKeys = Object.entries(process.env)
        .filter(([k, v]) => k.startsWith('WEBSCRAPINGAI_KEY_') && v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, v]) => String(v).trim())
        .filter(Boolean);

    const packed = String(process.env.WEBSCRAPINGAI_KEYS || '').trim();
    if (packed) {
        const list = packed.startsWith('[')
            ? JSON.parse(packed)
            : packed.split(/[\r\n,;]+/).map(k => k.trim()).filter(Boolean);
        list.forEach(k => { if (typeof k === 'string' && k) rawKeys.push(k); });
    }

    if (!rawKeys.length) {
        res.json({ ok: false, error: 'No WEBSCRAPINGAI_KEY_* configured' });
        return;
    }

    const apiKey = rawKeys[0];
    const useJs = req.query.js !== '0';
    const timeout = toPositiveInt(req.query.timeout, 25000, 5000);

    const wsUrl = new URL('https://api.webscraping.ai/html');
    wsUrl.searchParams.set('api_key', apiKey);
    wsUrl.searchParams.set('url', targetUrl);
    wsUrl.searchParams.set('js', useJs ? '1' : '0');
    wsUrl.searchParams.set('proxy', 'residential');
    wsUrl.searchParams.set('timeout', String(timeout));

    const maskedUrl = wsUrl.toString().replace(apiKey, apiKey.slice(0, 6) + '***');

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeout + 10000);
    const startMs = Date.now();

    try {
        const response = await fetch(wsUrl.toString(), { signal: controller.signal });
        const elapsed = Date.now() - startMs;
        const body = await response.text();
        const respHeaders = {};
        ['x-credits-used', 'x-credits-remaining', 'x-target-status', 'content-type', 'x-target-url'].forEach(h => {
            const v = response.headers.get(h);
            if (v) respHeaders[h] = v;
        });

        res.json({
            ok: response.ok,
            status: response.status,
            elapsedMs: elapsed,
            headers: respHeaders,
            bodyLength: body.length,
            bodyPreview: body.slice(0, 2000),
            requestUrl: maskedUrl
        });
    } catch (err) {
        const elapsed = Date.now() - startMs;
        res.json({ ok: false, error: err.message, elapsedMs: elapsed, requestUrl: maskedUrl });
    } finally {
        clearTimeout(tid);
    }
});

app.post('/api/extract-sources', requireApiKey, async (req, res) => {
    const targetUrl = normalizeHttpUrl(req.body && req.body.url);
    if (!targetUrl) {
        res.status(400).json({ ok: false, error: 'Missing or invalid url' });
        return;
    }

    try {
        const result = await fetchHtmlWithFallback(targetUrl, {
            render: parseBoolean(req.body.render, true),
            waitForSelector: String(req.body.waitForSelector || '[data-iframe]').trim(),
            sessionKey: String(req.body.sessionKey || '') || getAutoSessionKey(targetUrl),
            timeoutMs: toPositiveInt(req.body.timeoutMs, 35000, 5000),
            selectorTimeoutMs: toPositiveInt(req.body.selectorTimeoutMs, 12000, 500)
        });

        const sources = extractSourcesFromHtml(result.html || '');

        res.json({
            ok: true,
            url: targetUrl,
            finalUrl: result.finalUrl,
            strategy: result.strategy,
            blocked: Boolean(result.blocked),
            sourceCount: sources.length,
            sources,
            trace: result.trace,
            errors: result.errors
        });
    } catch (error) {
        res.status(502).json({
            ok: false,
            error: error && error.message ? error.message : String(error)
        });
    }
});

app.get('/api/search', requireApiKey, async (req, res) => {
    const query = String(getFirstQueryValue(req.query.query) || getFirstQueryValue(req.query.q) || '').trim();
    if (!query) {
        res.status(400).json({ ok: false, error: 'Missing query' });
        return;
    }

    const targetUrl = `https://zaluknij.cc/wyszukiwarka?phrase=${encodeURIComponent(query)}`;

    try {
        const result = await fetchHtmlWithFallback(targetUrl, {
            render: parseBoolean(getFirstQueryValue(req.query.render), false),
            sessionKey: String(getFirstQueryValue(req.query.session_number) || '') || getAutoSessionKey(targetUrl),
            timeoutMs: toPositiveInt(getFirstQueryValue(req.query.timeout_ms), 30000, 5000)
        });

        const items = extractSearchResults(result.html || '', targetUrl);

        res.json({
            ok: true,
            query,
            url: targetUrl,
            finalUrl: result.finalUrl,
            strategy: result.strategy,
            count: items.length,
            results: items,
            trace: result.trace,
            errors: result.errors
        });
    } catch (error) {
        res.status(502).json({
            ok: false,
            error: error && error.message ? error.message : String(error)
        });
    }
});

app.get('/', requireApiKey, async (req, res) => {
    const targetUrl = normalizeHttpUrl(getFirstQueryValue(req.query.url));
    if (!targetUrl) {
        res.status(400).type('text/plain').send('Missing or invalid url');
        return;
    }

    const render = parseBoolean(getFirstQueryValue(req.query.render), true);
    const waitForSelector = String(getFirstQueryValue(req.query.wait_for_selector) || '').trim();
    const sessionKey = String(getFirstQueryValue(req.query.session_number) || '').trim();
    const timeoutMs = toPositiveInt(getFirstQueryValue(req.query.timeout_ms), 35000, 5000);

    try {
        const result = await fetchHtmlWithFallback(targetUrl, {
            render,
            waitForSelector,
            sessionKey: sessionKey || getAutoSessionKey(targetUrl),
            timeoutMs,
            selectorTimeoutMs: toPositiveInt(getFirstQueryValue(req.query.selector_timeout_ms), 12000, 500)
        });

        res.setHeader('x-self-scraper-strategy', result.strategy);
        res.setHeader('x-self-scraper-final-url', result.finalUrl || targetUrl);
        res.setHeader('x-self-scraper-elapsed-ms', String(result.elapsedMs || 0));
        res.type('text/html').send(String(result.html || ''));
    } catch (error) {
        res.status(529).type('text/plain').send(error && error.message ? error.message : 'Scraper failed');
    }
});

app.listen(PORT, HOST, () => {
    console.log(`[scraper-server] listening on http://${HOST}:${PORT}`);
    console.log(`[scraper-server] webscraping.ai: ${hasWebscrapingKeys() ? 'configured' : 'not configured'}`);
});
