const fs = require('fs');
const path = require('path');
const { getConfigValue } = require('./api-helpers/_config');

const OFFICIAL_HTML_URL = 'https://api.webscraping.ai/html';
const OFFICIAL_ACCOUNT_URL = 'https://api.webscraping.ai/account';
const STATUS_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ACCEPT_LANGUAGE = 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7';

let cachedStatuses = [];
let cachedStatusesAt = 0;
let refreshPromise = null;

function normalizeEnvValue(rawValue) {
    const value = String(rawValue || '').trim();
    if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
            return value.slice(1, -1);
        }
    }

    return value;
}

function parseEnvFile(content) {
    return String(content || '').split(/\r?\n/).reduce((accumulator, line) => {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) {
            return accumulator;
        }

        const separatorIndex = trimmedLine.indexOf('=');
        if (separatorIndex === -1) {
            return accumulator;
        }

        const key = trimmedLine.slice(0, separatorIndex).trim();
        const value = normalizeEnvValue(trimmedLine.slice(separatorIndex + 1));
        if (key) {
            accumulator[key] = value;
        }

        return accumulator;
    }, {});
}

function loadDynamicEnvMap() {
    const merged = {};
    ['.env.example', '.env', '.env.local'].forEach((fileName) => {
        const filePath = path.join(process.cwd(), fileName);
        if (!fs.existsSync(filePath)) {
            return;
        }

        Object.assign(merged, parseEnvFile(fs.readFileSync(filePath, 'utf8')));
    });

    return {
        ...merged,
        ...process.env
    };
}

function getFirstQueryValue(value) {
    if (Array.isArray(value)) {
        return value[0];
    }

    return value;
}

function parseBoolean(value, fallbackValue = false) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
        return Boolean(fallbackValue);
    }

    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }

    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    return Boolean(fallbackValue);
}

function toPositiveInt(rawValue, fallbackValue, minValue = 1, maxValue = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(String(rawValue || '').trim(), 10);
    if (!Number.isInteger(parsed) || parsed < minValue) {
        return fallbackValue;
    }

    return Math.min(parsed, maxValue);
}

function normalizeHttpUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }

    try {
        const parsed = new URL(raw);
        if (!/^https?:$/i.test(parsed.protocol)) {
            return '';
        }

        return parsed.toString();
    } catch {
        return '';
    }
}

function maskKey(value) {
    const key = String(value || '').trim();
    if (key.length <= 8) {
        return key ? `${key.slice(0, 2)}...${key.slice(-2)}` : '';
    }

    return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function parseConfiguredKeyList(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) {
        return [];
    }

    if (value.startsWith('[')) {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) {
                return parsed.map((entry) => String(entry || '').trim()).filter(Boolean);
            }
        } catch {}
    }

    return value
        .split(/[\r\n,]+/)
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);
}

function getRoutingKeys() {
    const envMap = loadDynamicEnvMap();
    const keys = [];
    const seen = new Set();

    Object.keys(envMap)
        .filter((name) => /^WEBSCRAPINGAI_KEY_\d+$/i.test(name))
        .sort((left, right) => left.localeCompare(right, 'en'))
        .forEach((name) => {
            const value = normalizeEnvValue(envMap[name]);
            if (!value || seen.has(value)) {
                return;
            }

            seen.add(value);
            keys.push({
                id: name,
                key: value,
                source: 'indexed-env'
            });
        });

    parseConfiguredKeyList(envMap.WEBSCRAPINGAI_KEYS).forEach((value, index) => {
        if (!value || seen.has(value)) {
            return;
        }

        seen.add(value);
        keys.push({
            id: `WEBSCRAPINGAI_KEYS_${index + 1}`,
            key: value,
            source: 'list-env'
        });
    });

    const fallbackKeys = [
        normalizeEnvValue(envMap.WEBSCRAPING_AI_API_KEY),
        normalizeEnvValue(envMap.WEBSCRAPINGAI_API_KEY)
    ].filter(Boolean);

    fallbackKeys.forEach((value, index) => {
        if (seen.has(value)) {
            return;
        }

        seen.add(value);
        keys.push({
            id: index === 0 ? 'WEBSCRAPING_AI_API_KEY' : 'WEBSCRAPINGAI_API_KEY',
            key: value,
            source: 'fallback-env'
        });
    });

    return keys;
}

function getCompatApiKey() {
    return String(
        getConfigValue('WEBSCRAPINGAI_COMPAT_API_KEY')
        || getConfigValue('WEBSCRAPING_AI_COMPAT_API_KEY')
        || ''
    ).trim();
}

function getAppPassword() {
    return String(getConfigValue('APP_PASSWORD') || '').trim();
}

function getProvidedSecret(req, names = []) {
    for (const name of names) {
        const fromHeader = String(req.headers?.[name] || '').trim();
        if (fromHeader) {
            return fromHeader;
        }

        const fromQuery = String(getFirstQueryValue(req.query?.[name]) || '').trim();
        if (fromQuery) {
            return fromQuery;
        }
    }

    const authHeader = String(req.headers?.authorization || '').trim();
    if (/^Bearer\s+/i.test(authHeader)) {
        return authHeader.replace(/^Bearer\s+/i, '').trim();
    }

    return '';
}

function validateHtmlCompatApiKey(req) {
    const expected = getCompatApiKey();
    if (!expected) {
        return null;
    }

    const provided = getProvidedSecret(req, ['x-api-key', 'api_key']);
    if (provided === expected) {
        return null;
    }

    return { error: 'Brak dostepu. Bledny api_key.' };
}

function validateAppPassword(req) {
    const expected = getAppPassword();
    if (!expected) {
        return null;
    }

    const provided = getProvidedSecret(req, ['x-app-password', 'app_password']);
    if (provided === expected) {
        return null;
    }

    return { error: 'Bledne haslo albo brak dostepu.' };
}

function readRemainingApiCalls(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const directCandidates = [
        payload.remaining_api_calls,
        payload.remainingApiCalls,
        payload.credits,
        payload.remaining,
        payload.data && payload.data.remaining_api_calls,
        payload.data && payload.data.remainingApiCalls
    ];

    for (const candidate of directCandidates) {
        const parsed = Number(candidate);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return null;
}

async function probeRoutingKey(entry) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const accountUrl = new URL(OFFICIAL_ACCOUNT_URL);
    accountUrl.searchParams.set('api_key', entry.key);

    try {
        const response = await fetch(accountUrl, {
            headers: {
                Accept: 'application/json, text/plain;q=0.9, */*;q=0.8'
            },
            signal: controller.signal
        });

        const text = await response.text();
        let payload = null;

        try {
            payload = JSON.parse(text);
        } catch {}

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
        const leftHealthy = left && left.healthy ? 1 : 0;
        const rightHealthy = right && right.healthy ? 1 : 0;
        if (leftHealthy !== rightHealthy) {
            return rightHealthy - leftHealthy;
        }

        const leftRemaining = Number.isFinite(left?.remainingApiCalls) ? left.remainingApiCalls : -1;
        const rightRemaining = Number.isFinite(right?.remainingApiCalls) ? right.remainingApiCalls : -1;
        if (leftRemaining !== rightRemaining) {
            return rightRemaining - leftRemaining;
        }

        return String(left?.id || '').localeCompare(String(right?.id || ''), 'en');
    });

    return list[0] || null;
}

function getKeyForStatus(status) {
    const matched = getRoutingKeys().find((entry) => entry.id === status?.id);
    return matched || null;
}

async function refreshAllKeyStatuses(options = {}) {
    if (refreshPromise && !options.force) {
        return refreshPromise;
    }

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
        if (refreshPromise === work) {
            refreshPromise = null;
        }
    }
}

function getCachedStatuses() {
    return Array.isArray(cachedStatuses) ? cachedStatuses : [];
}

async function ensureFreshStatuses() {
    if (cachedStatusesAt && (Date.now() - cachedStatusesAt) < STATUS_TTL_MS && cachedStatuses.length > 0) {
        return cachedStatuses;
    }

    return refreshAllKeyStatuses();
}

function buildStatusResponse(statuses) {
    const active = pickBestStatus(statuses);
    return {
        ok: true,
        configuredKeysCount: Array.isArray(statuses) ? statuses.length : 0,
        activeKey: active ? {
            id: active.id,
            maskedKey: active.maskedKey,
            remainingApiCalls: active.remainingApiCalls,
            healthy: active.healthy,
            status: active.status
        } : null,
        keys: Array.isArray(statuses) ? statuses : [],
        updatedAt: cachedStatusesAt ? new Date(cachedStatusesAt).toISOString() : null
    };
}

function parseForwardHeaders(rawValue) {
    const baseHeaders = {
        'Accept-Language': DEFAULT_ACCEPT_LANGUAGE
    };

    const value = String(rawValue || '').trim();
    if (!value) {
        return baseHeaders;
    }

    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return baseHeaders;
        }

        return {
            ...baseHeaders,
            ...Object.entries(parsed).reduce((accumulator, [key, headerValue]) => {
                if (key && headerValue != null && headerValue !== '') {
                    accumulator[String(key)] = String(headerValue);
                }
                return accumulator;
            }, {})
        };
    } catch {
        return baseHeaders;
    }
}

function buildOfficialHtmlUrl(targetUrl, rawQuery, keyEntry) {
    const url = new URL(OFFICIAL_HTML_URL);
    const timeoutMs = toPositiveInt(getFirstQueryValue(rawQuery.timeout), 20000, 1000, 30000);
    const waitFor = String(getFirstQueryValue(rawQuery.wait_for) || getFirstQueryValue(rawQuery.wait_for_selector) || '').trim();
    const headers = parseForwardHeaders(getFirstQueryValue(rawQuery.headers));
    const useJs = parseBoolean(getFirstQueryValue(rawQuery.js), true);
    const requestedCountry = String(getFirstQueryValue(rawQuery.country) || '').trim().toLowerCase();

    url.searchParams.set('api_key', keyEntry.key);
    url.searchParams.set('url', targetUrl);
    url.searchParams.set('js', String(useJs));
    url.searchParams.set('proxy', 'residential');
    url.searchParams.set('device', String(getFirstQueryValue(rawQuery.device) || 'desktop').trim() || 'desktop');
    url.searchParams.set('timeout', String(timeoutMs));
    url.searchParams.set('js_timeout', String(toPositiveInt(getFirstQueryValue(rawQuery.js_timeout), Math.max(1500, timeoutMs - 1200), 1000, 20000)));
    if (requestedCountry) {
        url.searchParams.set('country', requestedCountry === 'pl' ? 'de' : requestedCountry);
    }
    if (waitFor) {
        url.searchParams.set('wait_for', waitFor);
    }
    url.searchParams.set('headers', JSON.stringify(headers));

    return url.toString();
}

async function forwardHtmlCompatRequest(rawQuery) {
    const targetUrl = normalizeHttpUrl(getFirstQueryValue(rawQuery.url));
    if (!targetUrl) {
        return {
            status: 400,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store'
            },
            body: JSON.stringify({ error: 'Missing or invalid url' })
        };
    }

    const statuses = await ensureFreshStatuses().catch(() => getCachedStatuses());
    const activeStatus = pickBestStatus(statuses);
    const activeKey = getKeyForStatus(activeStatus) || getRoutingKeys()[0] || null;
    if (!activeKey) {
        return {
            status: 503,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store'
            },
            body: JSON.stringify({ error: 'Brak skonfigurowanych kluczy WebScrapingAI.' })
        };
    }

    const providerUrl = buildOfficialHtmlUrl(targetUrl, rawQuery, activeKey);
    const controller = new AbortController();
    const upstreamTimeoutMs = toPositiveInt(getFirstQueryValue(rawQuery.timeout), 20000, 1000, 30000) + 2500;
    const timeoutId = setTimeout(() => controller.abort(), upstreamTimeoutMs);

    try {
        const response = await fetch(providerUrl, {
            headers: {
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            signal: controller.signal
        });

        const body = await response.text();
        return {
            status: response.ok ? 200 : response.status,
            headers: {
                'Content-Type': response.headers.get('content-type') || 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'x-target-status': String(response.headers.get('x-target-status') || response.status),
                'x-target-url': response.headers.get('x-target-url') || targetUrl,
                'x-router-selected-key': activeKey.id,
                'x-router-selected-key-mask': maskKey(activeKey.key)
            },
            body
        };
    } catch (error) {
        return {
            status: 502,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store'
            },
            body: String(error && error.message ? error.message : error)
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

function queueBackgroundRefresh() {
    if (refreshPromise) {
        return;
    }

    if (typeof setImmediate === 'function') {
        setImmediate(() => {
            refreshAllKeyStatuses().catch(() => null);
        });
        return;
    }

    setTimeout(() => {
        refreshAllKeyStatuses().catch(() => null);
    }, 0);
}

module.exports = {
    buildStatusResponse,
    ensureFreshStatuses,
    forwardHtmlCompatRequest,
    getCachedStatuses,
    queueBackgroundRefresh,
    refreshAllKeyStatuses,
    validateAppPassword,
    validateHtmlCompatApiKey
};