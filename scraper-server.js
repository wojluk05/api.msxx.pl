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

const browserService = createBrowserService({
    browserTimeoutMs: process.env.BROWSER_TIMEOUT_MS,
    sessionTtlMs: process.env.SESSION_TTL_MS,
    headless: process.env.BROWSER_HEADLESS ?? 'true',
    blockResources: process.env.BLOCK_RESOURCES ?? 'true',
    proxyServer: process.env.UPSTREAM_PROXY_SERVER,
    proxyUsername: process.env.UPSTREAM_PROXY_USERNAME,
    proxyPassword: process.env.UPSTREAM_PROXY_PASSWORD,
    cfMaxWaitMs: process.env.CF_MAX_WAIT_MS,
    cfClickRetries: process.env.CF_CLICK_RETRIES,
    userAgent: process.env.SCRAPER_USER_AGENT
});

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
    try {
        return await browserService.fetchHtml(targetUrl, options);
    } catch (browserError) {
        if (!hasWebscrapingKeys()) {
            throw browserError;
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
            throw new Error(`Browser failed: ${browserError.message} | WebscrapingAI failed: HTTP ${result.status}`);
        }

        return {
            ok: !blocked && result.ok,
            blocked,
            strategy: 'webscraping-ai',
            html,
            finalUrl: targetUrl,
            status: result.status,
            trace: [{ strategy: 'browser', error: browserError.message }, { strategy: 'webscraping-ai', blocked }],
            errors: [browserError.message]
        };
    }
}

app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        service: 'scraper-server',
        sessions: browserService.sessionStore.count(),
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

async function prewarmTargetSites() {
    const sites = (process.env.PREWARM_SITES || 'https://zaluknij.cc/').split(',').map((s) => s.trim()).filter(Boolean);
    for (const siteUrl of sites) {
        try {
            const hostname = new URL(siteUrl).hostname;
            console.log(`[prewarm] fetching ${siteUrl}`);
            await browserService.fetchHtml(siteUrl, {
                render: true,
                preferRealBrowser: true,
                connectTimeoutMs: 60000,
                sessionKey: hostname,
                timeoutMs: 60000,
                selectorTimeoutMs: 5000
            });
            console.log(`[prewarm] done ${hostname}`);
        } catch (err) {
            console.warn(`[prewarm] failed ${siteUrl}: ${err && err.message}`);
        }
    }
}

app.listen(PORT, HOST, () => {
    console.log(`[scraper-server] listening on http://${HOST}:${PORT}`);
    browserService.warmUp().then(() => prewarmTargetSites()).catch(() => null);
});
