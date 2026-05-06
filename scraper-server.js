import { createBrowserService } from './lib/scraper-browser.js';
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

function hasZenrowsKey() {
    return Boolean(String(process.env.ZENROWS_API_KEY || '').trim());
}

async function fetchWithZenrows(targetUrl, options = {}) {
    const zenrowsKey = String(process.env.ZENROWS_API_KEY || '').trim();
    if (!zenrowsKey) throw new Error('ZENROWS_API_KEY not configured');

    const useJs = options.render !== false;
    const usePremiumProxy = String(process.env.ZENROWS_PREMIUM_PROXY || 'true').trim().toLowerCase() !== 'false';
    const timeoutMs = toPositiveInt(options.timeoutMs, 35000, 5000);

    const url = new URL('https://api.zenrows.com/v1/');
    url.searchParams.set('apikey', zenrowsKey);
    url.searchParams.set('url', targetUrl);
    if (useJs) {
        url.searchParams.set('js_render', 'true');
    }
    if (usePremiumProxy) {
        url.searchParams.set('premium_proxy', 'true');
    }
    if (options.waitForSelector && useJs) {
        url.searchParams.set('wait_for', options.waitForSelector);
    } else if (useJs) {
        url.searchParams.set('wait', '2000');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url.toString(), { signal: controller.signal });
        const html = await response.text();

        if (!response.ok) {
            throw new Error(`Zenrows HTTP ${response.status}: ${html.slice(0, 120)}`);
        }

        const blocked = detectCloudflareChallenge(html, targetUrl);

        return {
            ok: !blocked,
            blocked,
            strategy: 'zenrows',
            html,
            finalUrl: targetUrl,
            status: 200,
            trace: [{ strategy: 'zenrows', blocked }],
            errors: []
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchHtmlWithFallback(targetUrl, options = {}) {
    if (hasZenrowsKey()) {
        try {
            const result = await fetchWithZenrows(targetUrl, options);
            if (result.ok) return result;
        } catch (zenErr) {
            console.warn(`[zenrows] ${targetUrl}: ${zenErr.message}`);
        }
    }

    if (!hasWebscrapingKeys()) {
        throw new Error('No scraping service configured (set ZENROWS_API_KEY or WEBSCRAPINGAI_KEY_*)');
    }

    const query = {
        url: targetUrl,
        js: options.render === false ? 'false' : 'true',
        proxy: 'residential'
    };

    if (options.waitForSelector) {
        query.wait_for_selector = options.waitForSelector;
    }

    const result = await forwardHtmlCompatRequest(query);
    const html = result.body ? result.body.toString('utf8') : '';
    const blocked = detectCloudflareChallenge(html, targetUrl);

    if (!result.ok && result.status >= 500) {
        throw new Error(`WebscrapingAI HTTP ${result.status}`);
    }

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
        zenrows: hasZenrowsKey(),
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
    console.log(`[scraper-server] zenrows: ${hasZenrowsKey() ? 'configured' : 'not configured'}`);
    console.log(`[scraper-server] webscraping.ai: ${hasWebscrapingKeys() ? 'configured' : 'not configured'}`);
});
