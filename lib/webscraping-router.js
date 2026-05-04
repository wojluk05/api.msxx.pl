const WEBSCRAPING_BASE_URL = process.env.WEBSCRAPINGAI_BASE_URL || 'https://api.webscraping.ai';
const STATUS_TTL_MS = Number(process.env.KEY_STATUS_TTL_MS || 60_000);
const FULL_REFRESH_TTL_MS = Number(process.env.KEY_STATUS_FULL_REFRESH_TTL_MS || 300_000);
const KEY_ENV_PREFIX = 'WEBSCRAPINGAI_KEY_';
const FORCED_PROXY = 'residential';
const FORCED_JS = true;

function getState() {
    if (!globalThis.__webScrapingRouterState) {
        globalThis.__webScrapingRouterState = {
            statuses: new Map(),
            lastFullRefreshAt: 0,
            pendingRefresh: null
        };
    }

    return globalThis.__webScrapingRouterState;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getSingleValue(value) {
    return Array.isArray(value) ? value[0] : value;
}

function normalizeEnvLabel(envName) {
    const normalized = envName
        .replace(KEY_ENV_PREFIX, '')
        .replace(/_/g, ' ')
        .trim();

    return normalized ? `KEY ${normalized}` : envName;
}

function maskKey(key) {
    if (!key) {
        return 'ukryty';
    }

    if (key.length <= 8) {
        return `${key.slice(0, 2)}***${key.slice(-2)}`;
    }

    return `${key.slice(0, 5)}...${key.slice(-4)}`;
}

function parseJsonList(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function toNumberOrNull(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function toComparableMetric(value) {
    const normalized = toNumberOrNull(value);
    return normalized === null ? -1 : normalized;
}

function compareDescending(leftValue, rightValue) {
    const left = toComparableMetric(leftValue);
    const right = toComparableMetric(rightValue);

    if (left === right) {
        return 0;
    }

    return left > right ? -1 : 1;
}

function normalizeResetTimestamp(value) {
    const unix = toNumberOrNull(value);
    if (unix === null) {
        return null;
    }

    return new Date(unix * 1000).toISOString();
}

function getConfiguredKeys() {
    const envEntries = Object.entries(process.env)
        .filter(([name, value]) => name.startsWith(KEY_ENV_PREFIX) && value)
        .sort(([a], [b]) => a.localeCompare(b));

    const fromNamedEnv = envEntries.map(([envName, key]) => ({
        id: envName,
        envName,
        configuredLabel: normalizeEnvLabel(envName),
        key
    }));

    const packedKeys = process.env.WEBSCRAPINGAI_KEYS || '';
    const packedList = packedKeys.trim().startsWith('[')
        ? parseJsonList(packedKeys)
        : packedKeys
            .split(/[\r\n,;]+/)
            .map((entry) => entry.trim())
            .filter(Boolean);

    const fromPackedEnv = packedList.map((entry, index) => {
        if (typeof entry === 'string') {
            return {
                id: `WEBSCRAPINGAI_KEYS_${index + 1}`,
                envName: `WEBSCRAPINGAI_KEYS_${index + 1}`,
                configuredLabel: `KEY ${index + 1}`,
                key: entry
            };
        }

        return {
            id: entry.id || entry.envName || `WEBSCRAPINGAI_KEYS_${index + 1}`,
            envName: entry.envName || `WEBSCRAPINGAI_KEYS_${index + 1}`,
            configuredLabel: entry.label || `KEY ${index + 1}`,
            key: entry.key
        };
    }).filter((entry) => entry.key);

    const unique = new Map();
    [...fromNamedEnv, ...fromPackedEnv].forEach((entry) => {
        unique.set(entry.id, entry);
    });

    return [...unique.values()];
}

function normalizeStatus(config, payload) {
    return {
        id: config.id,
        envName: config.envName,
        configuredLabel: config.configuredLabel,
        label: config.configuredLabel,
        remaining: toNumberOrNull(payload?.remaining_api_calls) ?? 0,
        remainingConcurrency: toNumberOrNull(payload?.remaining_concurrency),
        resetsAt: normalizeResetTimestamp(payload?.resets_at),
        keyPreview: maskKey(config.key),
        lastCreditsUsed: null,
        lastTargetStatus: null,
        status: 'ok',
        error: null,
        updatedAt: Date.now()
    };
}

function normalizeErrorStatus(config, errorMessage) {
    return {
        id: config.id,
        envName: config.envName,
        configuredLabel: config.configuredLabel,
        label: config.configuredLabel,
        remaining: 0,
        remainingConcurrency: null,
        resetsAt: null,
        keyPreview: maskKey(config.key),
        lastCreditsUsed: null,
        lastTargetStatus: null,
        status: 'error',
        error: errorMessage,
        updatedAt: Date.now()
    };
}

async function parseJsonResponse(response) {
    const text = await response.text();

    try {
        return text ? JSON.parse(text) : null;
    } catch {
        return null;
    }
}

async function fetchKeyStatus(config) {
    const accountUrl = new URL('/account', WEBSCRAPING_BASE_URL);
    accountUrl.searchParams.set('api_key', config.key);

    const response = await fetch(accountUrl, { method: 'GET' });
    const payload = await parseJsonResponse(response);

    if (!response.ok) {
        const errorMessage = payload?.error || payload?.message || `WebScrapingAI account check failed (${response.status})`;
        throw new Error(errorMessage);
    }

    return normalizeStatus(config, payload);
}

export function getCachedStatuses() {
    const state = getState();
    const configs = getConfiguredKeys();

    return configs.map((config) => {
        const cached = state.statuses.get(config.id);
        return cached || {
            id: config.id,
            envName: config.envName,
            configuredLabel: config.configuredLabel,
            label: config.configuredLabel,
            remaining: null,
            remainingConcurrency: null,
            resetsAt: null,
            keyPreview: maskKey(config.key),
            lastCreditsUsed: null,
            lastTargetStatus: null,
            status: 'unknown',
            error: null,
            updatedAt: 0
        };
    });
}

function sortStatuses(statuses) {
    return [...statuses].sort((left, right) => {
        if (left.status === 'ok' && right.status !== 'ok') {
            return -1;
        }

        if (right.status === 'ok' && left.status !== 'ok') {
            return 1;
        }

        const remainingComparison = compareDescending(left.remaining, right.remaining);
        if (remainingComparison !== 0) {
            return remainingComparison;
        }

        const concurrencyComparison = compareDescending(left.remainingConcurrency, right.remainingConcurrency);
        if (concurrencyComparison !== 0) {
            return concurrencyComparison;
        }

        return right.updatedAt - left.updatedAt;
    });
}

export async function refreshAllKeyStatuses(options = {}) {
    const { force = false } = options;
    const state = getState();
    const now = Date.now();

    if (!force && state.pendingRefresh) {
        return state.pendingRefresh;
    }

    if (!force && state.lastFullRefreshAt && now - state.lastFullRefreshAt < STATUS_TTL_MS) {
        return sortStatuses(getCachedStatuses());
    }

    const configs = getConfiguredKeys();
    const refreshPromise = Promise.all(configs.map(async (config) => {
        try {
            return await fetchKeyStatus(config);
        } catch (error) {
            return normalizeErrorStatus(config, error.message);
        }
    })).then((statuses) => {
        statuses.forEach((status) => {
            state.statuses.set(status.id, status);
        });
        state.lastFullRefreshAt = Date.now();
        return sortStatuses(statuses);
    }).finally(() => {
        state.pendingRefresh = null;
    });

    state.pendingRefresh = refreshPromise;
    return refreshPromise;
}

export function queueBackgroundRefresh() {
    const state = getState();

    if (state.pendingRefresh) {
        return state.pendingRefresh;
    }

    state.pendingRefresh = refreshAllKeyStatuses({ force: true }).catch(() => {
        return sortStatuses(getCachedStatuses());
    }).finally(() => {
        state.pendingRefresh = null;
    });

    return state.pendingRefresh;
}

export function getBestStatus(statuses = getCachedStatuses()) {
    return sortStatuses(statuses).find((status) => status.status === 'ok') || null;
}

function getRankedConfigs(statuses, configs) {
    const statusById = new Map(statuses.map((status) => [status.id, status]));

    return [...configs].sort((left, right) => {
        const leftStatus = statusById.get(left.id);
        const rightStatus = statusById.get(right.id);

        if (!leftStatus && rightStatus) {
            return 1;
        }

        if (!rightStatus && leftStatus) {
            return -1;
        }

        if (!leftStatus && !rightStatus) {
            return left.envName.localeCompare(right.envName);
        }

        const remainingComparison = compareDescending(leftStatus.remaining, rightStatus.remaining);
        if (remainingComparison !== 0) {
            return remainingComparison;
        }

        const concurrencyComparison = compareDescending(leftStatus.remainingConcurrency, rightStatus.remainingConcurrency);
        if (concurrencyComparison !== 0) {
            return concurrencyComparison;
        }

        return left.envName.localeCompare(right.envName);
    });
}

function updateStatusFromProviderResponse(keyId, response) {
    const state = getState();
    const current = state.statuses.get(keyId);

    if (!current) {
        return;
    }

    const remainingHeader = toNumberOrNull(response.headers.get('x-credits-remaining'));
    const usedHeader = toNumberOrNull(response.headers.get('x-credits-used'));
    const targetStatusHeader = toNumberOrNull(response.headers.get('x-target-status'));

    let remaining = current.remaining;
    if (remainingHeader !== null) {
        remaining = remainingHeader;
    } else if (usedHeader !== null && current.remaining !== null) {
        remaining = Math.max(0, current.remaining - usedHeader);
    }

    state.statuses.set(keyId, {
        ...current,
        remaining,
        lastCreditsUsed: usedHeader,
        lastTargetStatus: targetStatusHeader,
        status: 'ok',
        error: null,
        updatedAt: Date.now()
    });
}

function markStatusUnavailable(keyId, message, statusCode = null) {
    const state = getState();
    const current = state.statuses.get(keyId);

    if (!current) {
        return;
    }

    state.statuses.set(keyId, {
        ...current,
        remaining: 0,
        remainingConcurrency: statusCode === 429 ? 0 : current.remainingConcurrency,
        status: 'error',
        error: message,
        updatedAt: Date.now()
    });
}

function getRequestPayload(body) {
    if (!body) {
        return null;
    }

    if (typeof body === 'string') {
        try {
            return JSON.parse(body);
        } catch {
            return null;
        }
    }

    return body;
}

function normalizeEndpoint(endpoint) {
    if (typeof endpoint !== 'string') {
        throw new Error('endpoint musi byc tekstem.');
    }

    const trimmed = endpoint.trim();
    if (!trimmed) {
        return '/html';
    }

    if (/^https?:\/\//i.test(trimmed)) {
        throw new Error('endpoint musi byc sciezka WebScrapingAI, nie pelnym URL.');
    }

    const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    if (normalized === '/account') {
        throw new Error('Do sprawdzania kluczy uzyj /api/status.');
    }

    if (!/^\/[a-z0-9/_-]+$/i.test(normalized)) {
        throw new Error('endpoint zawiera niedozwolone znaki.');
    }

    return normalized;
}

function appendParam(searchParams, key, value) {
    if (value === null || value === undefined) {
        return;
    }

    if (Array.isArray(value)) {
        value.forEach((entry) => {
            appendParam(searchParams, `${key}[]`, entry);
        });
        return;
    }

    if (isPlainObject(value)) {
        Object.entries(value).forEach(([nestedKey, nestedValue]) => {
            appendParam(searchParams, `${key}[${nestedKey}]`, nestedValue);
        });
        return;
    }

    searchParams.append(key, String(value));
}

function buildClientRequest(rawBody) {
    const payload = getRequestPayload(rawBody);
    if (!isPlainObject(payload)) {
        throw new Error('Body musi byc poprawnym JSON-em.');
    }

    const {
        endpoint,
        path,
        method = 'GET',
        params,
        ...rest
    } = payload;

    const normalizedMethod = String(method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(normalizedMethod)) {
        throw new Error('Obslugiwane metody to GET i POST.');
    }

    return {
        endpoint: normalizeEndpoint(endpoint || path || '/html'),
        method: normalizedMethod,
        params: {
            ...rest,
            ...(isPlainObject(params) ? params : {})
        }
    };
}

function buildProviderRequest(config, clientRequest, options = {}) {
    const {
        forcedProxy = FORCED_PROXY,
        forcedJs = FORCED_JS
    } = options;
    const url = new URL(clientRequest.endpoint, WEBSCRAPING_BASE_URL);
    const providerParams = {
        ...clientRequest.params,
        api_key: config.key
    };

    if (forcedProxy !== undefined) {
        providerParams.proxy = forcedProxy;
    }

    if (forcedJs !== undefined) {
        providerParams.js = forcedJs;
    }

    if (clientRequest.method === 'GET') {
        Object.entries(providerParams).forEach(([key, value]) => {
            appendParam(url.searchParams, key, value);
        });

        return {
            url,
            init: {
                method: 'GET'
            }
        };
    }

    const body = new URLSearchParams();
    Object.entries(providerParams).forEach(([key, value]) => {
        appendParam(body, key, value);
    });

    return {
        url,
        init: {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: body.toString()
        }
    };
}

function buildForwardHeaders(response) {
    const forwarded = {};
    const names = [
        'content-type',
        'content-disposition',
        'x-credits-used',
        'x-credits-remaining',
        'x-target-status',
        'x-target-url'
    ];

    names.forEach((name) => {
        const value = response.headers.get(name);
        if (value) {
            forwarded[name] = value;
        }
    });

    return forwarded;
}

function extractErrorMessage(bodyBuffer, statusCode) {
    const text = bodyBuffer.toString('utf8').trim();
    if (!text) {
        return `WebScrapingAI request failed (${statusCode})`;
    }

    try {
        const parsed = JSON.parse(text);
        return parsed?.error || parsed?.message || text;
    } catch {
        return text;
    }
}

function createJsonErrorResult(status, message, extra = {}) {
    return {
        ok: false,
        status,
        body: Buffer.from(JSON.stringify({ error: message, ...extra })),
        headers: { 'content-type': 'application/json; charset=utf-8' },
        selectedKey: null
    };
}

function normalizeHtmlCompatServiceStatus(status) {
    if (status === 529) {
        return 529;
    }

    if (status === 503) {
        return 529;
    }

    if ([408, 500, 502, 504, 522, 524].includes(status)) {
        return 502;
    }

    return status;
}

function normalizeTargetUrl(rawValue) {
    const value = getSingleValue(rawValue);

    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('Parametr url jest wymagany.');
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(value.trim());
    } catch {
        throw new Error('Parametr url musi byc poprawnym adresem http lub https.');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Parametr url musi byc poprawnym adresem http lub https.');
    }

    return parsedUrl.toString();
}

function parseHtmlCompatHeaders(rawValue) {
    const value = getSingleValue(rawValue);

    if (value === null || value === undefined || value === '') {
        return undefined;
    }

    if (isPlainObject(value)) {
        return value;
    }

    if (typeof value !== 'string') {
        throw new Error('Parametr headers musi byc poprawnym JSON-em z obiektem naglowkow.');
    }

    let parsedValue;
    try {
        parsedValue = JSON.parse(value);
    } catch {
        throw new Error('Parametr headers musi byc poprawnym JSON-em z obiektem naglowkow.');
    }

    if (!isPlainObject(parsedValue)) {
        throw new Error('Parametr headers musi byc poprawnym JSON-em z obiektem naglowkow.');
    }

    return parsedValue;
}

export function buildHtmlCompatRequest(query = {}) {
    const params = {
        url: normalizeTargetUrl(query.url),
        js: getSingleValue(query.js),
        wait_for: getSingleValue(query.wait_for),
        proxy: getSingleValue(query.proxy),
        country: getSingleValue(query.country),
        device: getSingleValue(query.device),
        timeout: getSingleValue(query.timeout),
        js_timeout: getSingleValue(query.js_timeout),
        headers: parseHtmlCompatHeaders(query.headers)
    };

    return {
        endpoint: '/html',
        method: 'GET',
        params: Object.fromEntries(Object.entries(params).filter(([, value]) => {
            return value !== null && value !== undefined && value !== '';
        }))
    };
}

function getHtmlCompatApiKey(req) {
    const headerValue = getSingleValue(req.headers?.['x-api-key']);
    if (typeof headerValue === 'string' && headerValue.trim()) {
        return headerValue.trim();
    }

    const queryValue = getSingleValue(req.query?.api_key);
    if (typeof queryValue === 'string' && queryValue.trim()) {
        return queryValue.trim();
    }

    return null;
}

export function validateHtmlCompatApiKey(req) {
    const expectedApiKey = process.env.WEBSCRAPINGAI_COMPAT_API_KEY || process.env.APP_PASSWORD;

    if (!expectedApiKey) {
        return null;
    }

    if (getHtmlCompatApiKey(req) !== expectedApiKey) {
        return { error: 'Brak dostepu. Bledny api_key.' };
    }

    return null;
}

export function buildStatusResponse(statuses = getCachedStatuses()) {
    const sortedStatuses = sortStatuses(statuses);
    const state = getState();
    const bestKey = getBestStatus(sortedStatuses);
    const healthyKeyCount = sortedStatuses.filter((status) => status.status === 'ok').length;

    return {
        provider: 'webscrapingai',
        strategy: 'highest_remaining_api_calls',
        forcedRequestConfig: {
            proxy: FORCED_PROXY,
            js: FORCED_JS
        },
        configuredKeyCount: sortedStatuses.length,
        healthyKeyCount,
        bestKey,
        lastRefreshAt: state.lastFullRefreshAt || null,
        stale: !state.lastFullRefreshAt || Date.now() - state.lastFullRefreshAt > FULL_REFRESH_TTL_MS,
        keys: sortedStatuses
    };
}

export async function ensureFreshStatuses() {
    const state = getState();
    const shouldRefresh = !state.lastFullRefreshAt || Date.now() - state.lastFullRefreshAt > STATUS_TTL_MS;

    if (shouldRefresh) {
        return refreshAllKeyStatuses({ force: true });
    }

    return sortStatuses(getCachedStatuses());
}

export async function forwardHtmlCompatRequest(query = {}) {
    const configs = getConfiguredKeys();
    if (!configs.length) {
        return createJsonErrorResult(500, 'Brak skonfigurowanych kluczy WEBSCRAPINGAI_KEY_* lub WEBSCRAPINGAI_KEYS.');
    }

    let clientRequest;
    try {
        clientRequest = buildHtmlCompatRequest(query);
    } catch (error) {
        return createJsonErrorResult(400, error.message);
    }

    const statuses = await ensureFreshStatuses();
    const rankedConfigs = getRankedConfigs(statuses, configs);
    const errors = [];

    for (const config of rankedConfigs) {
        const selectedStatus = getCachedStatuses().find((entry) => entry.id === config.id) || null;

        try {
            const providerRequest = buildProviderRequest(config, clientRequest, {
                forcedProxy: undefined,
                forcedJs: undefined
            });
            const response = await fetch(providerRequest.url, providerRequest.init);
            const body = Buffer.from(await response.arrayBuffer());
            const headers = buildForwardHeaders(response);
            const hasTargetStatus = Boolean(headers['x-target-status']);

            if (!response.ok && !hasTargetStatus) {
                const errorMessage = extractErrorMessage(body, response.status);

                if ([401, 402, 403, 429].includes(response.status)) {
                    markStatusUnavailable(config.id, errorMessage, response.status);
                    errors.push({ key: config.envName, status: response.status, message: errorMessage });
                    continue;
                }

                return {
                    ok: false,
                    status: normalizeHtmlCompatServiceStatus(response.status),
                    body,
                    headers,
                    selectedKey: selectedStatus
                };
            }

            updateStatusFromProviderResponse(config.id, response);

            return {
                ok: true,
                status: 200,
                body,
                headers: {
                    ...headers,
                    'content-type': headers['content-type'] || 'text/html; charset=utf-8'
                },
                selectedKey: selectedStatus
            };
        } catch (error) {
            markStatusUnavailable(config.id, error.message, 500);
            errors.push({ key: config.envName, status: 500, message: error.message });
        }
    }

    return createJsonErrorResult(529, 'Zaden klucz nie mogl obsluzyc zapytania.', { attempts: errors });
}

export async function forwardWebScrapingRequest(rawBody) {
    const configs = getConfiguredKeys();
    if (!configs.length) {
        return createJsonErrorResult(500, 'Brak skonfigurowanych kluczy WEBSCRAPINGAI_KEY_* lub WEBSCRAPINGAI_KEYS.');
    }

    let clientRequest;
    try {
        clientRequest = buildClientRequest(rawBody);
    } catch (error) {
        return createJsonErrorResult(400, error.message);
    }

    const statuses = await ensureFreshStatuses();
    const rankedConfigs = getRankedConfigs(statuses, configs);
    const errors = [];

    for (const config of rankedConfigs) {
        const selectedStatus = getCachedStatuses().find((entry) => entry.id === config.id) || null;

        try {
            const providerRequest = buildProviderRequest(config, clientRequest);
            const response = await fetch(providerRequest.url, providerRequest.init);
            const body = Buffer.from(await response.arrayBuffer());
            const headers = buildForwardHeaders(response);

            if (!response.ok) {
                const errorMessage = extractErrorMessage(body, response.status);

                if ([401, 402, 403, 429].includes(response.status)) {
                    markStatusUnavailable(config.id, errorMessage, response.status);
                    errors.push({ key: config.envName, status: response.status, message: errorMessage });
                    continue;
                }

                return {
                    ok: false,
                    status: response.status,
                    body,
                    headers,
                    selectedKey: selectedStatus
                };
            }

            updateStatusFromProviderResponse(config.id, response);

            return {
                ok: true,
                status: response.status,
                body,
                headers,
                selectedKey: selectedStatus
            };
        } catch (error) {
            markStatusUnavailable(config.id, error.message, 500);
            errors.push({ key: config.envName, status: 500, message: error.message });
        }
    }

    return createJsonErrorResult(503, 'Zaden klucz nie mogl obsluzyc zapytania.', { attempts: errors });
}

export function validateAppPassword(req) {
    const appPassword = process.env.APP_PASSWORD;
    const clientPassword = getSingleValue(req.headers['x-app-password']);

    if (!appPassword) {
        return null;
    }

    if (clientPassword !== appPassword) {
        return { error: 'Brak dostepu. Bledne haslo.' };
    }

    return null;
}