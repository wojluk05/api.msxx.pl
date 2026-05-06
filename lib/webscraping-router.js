const OFFICIAL_HTML_URL = 'https://api.webscraping.ai/html';
const OFFICIAL_ACCOUNT_URL = 'https://api.webscraping.ai/account';
const STATUS_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ACCEPT_LANGUAGE = 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7';

let cachedStatuses = [];
let cachedStatusesAt = 0;
let refreshPromise = null;

function getFirstQueryValue(value) {
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
}

function parseBoolean(value, fallbackValue = false) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return Boolean(fallbackValue);
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return Boolean(fallbackValue);
}

function toPositiveInt(rawValue, fallbackValue, minValue = 1, maxValue = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(String(rawValue || '').trim(), 10);
    if (!Number.isInteger(parsed) || parsed < minValue) return fallbackValue;
    return Math.min(parsed, maxValue);
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

function maskKey(value) {
    const key = String(value || '').trim();
    if (key.length <= 8) return key ? `${key.slice(0, 2)}...${key.slice(-2)}` : '';
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function readRemainingApiCalls(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const candidates = [
        payload.remaining_api_calls,
        payload.remainingApiCalls,
        payload.credits,
        payload.remaining,
        payload.data && payload.data.remaining_api_calls,
        payload.data && payload.data.remainingApiCalls
    ];
    for (const candidate of candidates) {
        const parsed = Number(candidate);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function getRoutingKeys() {
    const keys = [];
    const seen = new Set();

    Object.keys(process.env)
        .filter((name) => /^WEBSCRAPINGAI_KEY_\d+$/i.test(name))
        .sort((a, b) => a.localeCompare(b, 'en'))
        .forEach((name) => {
            const value = String(process.env[name] || '').trim();
            if (!value || seen.has(value)) return;
            seen.add(value);
            keys.push({ id: name, key: value, source: 'indexed-env' });
        });

    const packed = String(process.env.WEBSCRAPINGAI_KEYS || '').trim();
    if (packed) {
        const list = packed.startsWith('[')
            ? JSON.parse(packed)
            : packed.split(/[\r\n,]+/).map((e) => e.trim()).filter(Boolean);
        list.forEach((value, index) => {
            const v = typeof value === 'string' ? value.trim() : '';
            if (!v || seen.has(v)) return;
            seen.add(v);
            keys.push({ id: `WEBSCRAPINGAI_KEYS_${index + 1}`, key: v, source: 'list-env' });
        });
    }

    const fallbacks = [
        process.env.WEBSCRAPING_AI_API_KEY,
        process.env.WEBSCRAPINGAI_API_KEY
    ].filter(Boolean);
    fallbacks.forEach((value, index) => {
        const v = String(value).trim();
        if (!v || seen.has(v)) return;
        seen.add(v);
        keys.push({
            id: index === 0 ? 'WEBSCRAPING_AI_API_KEY' : 'WEBSCRAPINGAI_API_KEY',
            key: v,
            source: 'fallback-env'
        });
    });

    return keys;
}

async function probeRoutingKey(entry) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const accountUrl = new URL(OFFICIAL_ACCOUNT_URL);
    accountUrl.searchParams.set('api_key', entry.key);

    try {
        const response = await fetch(accountUrl, {
            headers: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.8' },
            signal: controller.signal
        });
        const text = await response.text();
        let payload = null;
        try { payload = JSON.parse(text); } catch {}
        return {
            id: entry.id,
            source: entry.source,
            maskedKey: maskKey(entry.key),
            healthy: response.ok,
            status: response.status,
            remainingApiCalls: readRemainingApiCalls(payload),
            checkedAt: new Date().toISOString(),
            error: response.ok ? '' : String(text || `HTTP ${response.status}`).slice(0, 240)
        };
    } catch (error) {
        return {
            id: entry.id,
            source: entry.source,
            maskedKey: maskKey(entry.key),
            healthy: false,
            status: 0,
            remainingApiCalls: null,
            checkedAt: new Date().toISOString(),
            error: String(error && error.message ? error.message : error)
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

function pickBestStatus(statuses) {
    const list = Array.isArray(statuses) ? statuses.slice() : [];
    list.sort((left, right) => {
        const lh = left && left.healthy ? 1 : 0;
        const rh = right && right.healthy ? 1 : 0;
        if (lh !== rh) return rh - lh;
        const lr = Number.isFinite(left?.remainingApiCalls) ? left.remainingApiCalls : -1;
        const rr = Number.isFinite(right?.remainingApiCalls) ? right.remainingApiCalls : -1;
        if (lr !== rr) return rr - lr;
        return String(left?.id || '').localeCompare(String(right?.id || ''), 'en');
    });
    return list[0] || null;
}

function getKeyForStatus(status) {
    return getRoutingKeys().find((entry) => entry.id === status?.id) || null;
}

export async function refreshAllKeyStatuses(options = {}) {
    if (refreshPromise && !options.force) return refreshPromise;

    const work = (async () => {
        const keys = getRoutingKeys();
        const statuses = await Promise.all(keys.map((entry) => probeRoutingKey(entry)));
        cachedStatuses = statuses;
        cachedStatusesAt = Date.now();
        return statuses;
    })();

    refreshPromise = work;
    try {
        return await work;
    } finally {
        if (refreshPromise === work) refreshPromise = null;
    }
}

export function getCachedStatuses() {
    return Array.isArray(cachedStatuses) ? cachedStatuses : [];
}

export async function ensureFreshStatuses() {
    if (cachedStatusesAt && (Date.now() - cachedStatusesAt) < STATUS_TTL_MS && cachedStatuses.length > 0) {
        return cachedStatuses;
    }
    return refreshAllKeyStatuses();
}

export function buildStatusResponse(statuses) {
    const active = pickBestStatus(statuses);
    return {
        ok: true,
        configuredKeysCount: Array.isArray(statuses) ? statuses.length : 0,
        healthyKeyCount: Array.isArray(statuses) ? statuses.filter(s => s && s.healthy).length : 0,
        bestKey: active ? {
            id: active.id,
            label: active.id,
            maskedKey: active.maskedKey,
            remainingApiCalls: active.remainingApiCalls,
            remaining: active.remainingApiCalls,
            healthy: active.healthy,
            status: active.status
        } : null,
        keys: Array.isArray(statuses) ? statuses : [],
        updatedAt: cachedStatusesAt ? new Date(cachedStatusesAt).toISOString() : null
    };
}

export function queueBackgroundRefresh() {
    if (refreshPromise) return;
    if (typeof setImmediate === 'function') {
        setImmediate(() => { refreshAllKeyStatuses().catch(() => null); });
        return;
    }
    setTimeout(() => { refreshAllKeyStatuses().catch(() => null); }, 0);
}

function parseForwardHeaders(rawValue) {
    const baseHeaders = { 'Accept-Language': DEFAULT_ACCEPT_LANGUAGE };
    const value = String(rawValue || '').trim();
    if (!value) return baseHeaders;
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return baseHeaders;
        return {
            ...baseHeaders,
            ...Object.entries(parsed).reduce((acc, [k, v]) => {
                if (k && v != null && v !== '') acc[String(k)] = String(v);
                return acc;
            }, {})
        };
    } catch {
        return baseHeaders;
    }
}

function buildOfficialHtmlUrl(targetUrl, rawQuery, keyEntry) {
    const url = new URL(OFFICIAL_HTML_URL);
    const timeoutMs = toPositiveInt(getFirstQueryValue(rawQuery.timeout), 25000, 1000, 30000);
    const waitFor = String(
        getFirstQueryValue(rawQuery.wait_for_css) ||
        getFirstQueryValue(rawQuery.wait_for_selector) ||
        getFirstQueryValue(rawQuery.wait_for) ||
        ''
    ).trim();
    const headers = parseForwardHeaders(getFirstQueryValue(rawQuery.headers));
    const useJs = parseBoolean(getFirstQueryValue(rawQuery.js), true);
    const requestedCountry = String(getFirstQueryValue(rawQuery.country) || '').trim().toLowerCase();

    url.searchParams.set('api_key', keyEntry.key);
    url.searchParams.set('url', targetUrl);
    url.searchParams.set('js', useJs ? 'true' : 'false');
    url.searchParams.set('proxy', String(getFirstQueryValue(rawQuery.proxy) || 'stealth').trim() || 'stealth');
    url.searchParams.set('device', String(getFirstQueryValue(rawQuery.device) || 'desktop').trim() || 'desktop');
    url.searchParams.set('timeout', String(timeoutMs));
    url.searchParams.set('js_timeout', String(toPositiveInt(getFirstQueryValue(rawQuery.js_timeout), 8000, 1000, 20000)));
    if (requestedCountry) {
        url.searchParams.set('country', requestedCountry === 'pl' ? 'de' : requestedCountry);
    }
    if (waitFor) {
        url.searchParams.set('wait_for', waitFor);
    }
    url.searchParams.set('headers', JSON.stringify(headers));

    return url.toString();
}

export async function forwardHtmlCompatRequest(rawQuery) {
    const targetUrl = normalizeHttpUrl(getFirstQueryValue(rawQuery.url));
    if (!targetUrl) {
        return {
            status: 400,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
            body: JSON.stringify({ error: 'Missing or invalid url' })
        };
    }

    const statuses = await ensureFreshStatuses().catch(() => getCachedStatuses());
    const activeStatus = pickBestStatus(statuses);
    const activeKey = getKeyForStatus(activeStatus) || getRoutingKeys()[0] || null;

    if (!activeKey) {
        return {
            status: 503,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
            body: JSON.stringify({ error: 'Brak skonfigurowanych kluczy WebScrapingAI.' })
        };
    }

    const providerUrl = buildOfficialHtmlUrl(targetUrl, rawQuery, activeKey);
    const timeoutMs = toPositiveInt(getFirstQueryValue(rawQuery.timeout), 25000, 1000, 30000);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs + 5000);

    try {
        const response = await fetch(providerUrl, {
            headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
            signal: controller.signal
        });
        const body = await response.text();
        const status = response.ok ? 200 : response.status;
        console.log(`[wsai] ${targetUrl} → HTTP ${response.status} (key: ${activeKey.id})`);
        return {
            ok: response.ok,
            status,
            headers: {
                'Content-Type': response.headers.get('content-type') || 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'x-target-status': String(response.headers.get('x-target-status') || response.status),
                'x-target-url': response.headers.get('x-target-url') || targetUrl,
                'x-credits-remaining': response.headers.get('x-credits-remaining') || '',
                'x-credits-used': response.headers.get('x-credits-used') || '',
                'x-router-selected-key': activeKey.id
            },
            body
        };
    } catch (error) {
        console.error(`[wsai] ${targetUrl} → fetch error: ${error.message}`);
        return {
            ok: false,
            status: 502,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
            body: String(error && error.message ? error.message : error)
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

export function validateHtmlCompatApiKey(req) {
    const expected = String(
        process.env.WEBSCRAPINGAI_COMPAT_API_KEY ||
        process.env.WEBSCRAPING_AI_COMPAT_API_KEY ||
        process.env.APP_PASSWORD ||
        ''
    ).trim();
    if (!expected) return null;

    const fromHeader = String(req.headers?.['x-api-key'] || '').trim();
    const fromQuery = String(req.query?.api_key || '').trim();
    const fromAuth = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const provided = fromHeader || fromQuery || fromAuth;

    if (provided === expected) return null;
    return { error: 'Brak dostepu. Bledny api_key.' };
}
