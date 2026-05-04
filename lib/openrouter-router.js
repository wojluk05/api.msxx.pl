const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const STATUS_TTL_MS = Number(process.env.KEY_STATUS_TTL_MS || 60_000);
const FULL_REFRESH_TTL_MS = Number(process.env.KEY_STATUS_FULL_REFRESH_TTL_MS || 300_000);
const KEY_ENV_PREFIX = 'OPENROUTER_KEY_';

function getState() {
    if (!globalThis.__openRouterRouterState) {
        globalThis.__openRouterRouterState = {
            statuses: new Map(),
            lastFullRefreshAt: 0,
            pendingRefresh: null
        };
    }

    return globalThis.__openRouterRouterState;
}

function normalizeEnvLabel(envName) {
    return envName
        .replace(KEY_ENV_PREFIX, '')
        .replace(/_/g, ' ')
        .trim() || envName;
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

    const packedKeys = process.env.OPENROUTER_KEYS || '';
    const packedList = packedKeys.trim().startsWith('[')
        ? parseJsonList(packedKeys)
        : packedKeys
            .split(/[\r\n,;]+/)
            .map((entry) => entry.trim())
            .filter(Boolean);

    const fromPackedEnv = packedList.map((entry, index) => {
        if (typeof entry === 'string') {
            return {
                id: `OPENROUTER_KEYS_${index + 1}`,
                envName: `OPENROUTER_KEYS_${index + 1}`,
                configuredLabel: `KEY ${index + 1}`,
                key: entry
            };
        }

        return {
            id: entry.id || entry.envName || `OPENROUTER_KEYS_${index + 1}`,
            envName: entry.envName || `OPENROUTER_KEYS_${index + 1}`,
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

function buildHeaders(apiKey) {
    const headers = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    };

    if (process.env.OPENROUTER_HTTP_REFERER) {
        headers['HTTP-Referer'] = process.env.OPENROUTER_HTTP_REFERER;
    }

    if (process.env.OPENROUTER_APP_TITLE) {
        headers['X-OpenRouter-Title'] = process.env.OPENROUTER_APP_TITLE;
    }

    return headers;
}

function toComparableRemaining(remaining) {
    if (remaining === null || remaining === undefined) {
        return Number.POSITIVE_INFINITY;
    }

    return Number(remaining) || 0;
}

function compareRemaining(leftRemaining, rightRemaining) {
    const leftScore = toComparableRemaining(leftRemaining);
    const rightScore = toComparableRemaining(rightRemaining);

    if (leftScore === rightScore) {
        return 0;
    }

    if (leftScore === Number.POSITIVE_INFINITY) {
        return 1;
    }

    if (rightScore === Number.POSITIVE_INFINITY) {
        return -1;
    }

    return leftScore > rightScore ? 1 : -1;
}

function normalizeStatus(config, payload) {
    const data = payload?.data || {};

    return {
        id: config.id,
        envName: config.envName,
        configuredLabel: config.configuredLabel,
        label: data.label || config.configuredLabel,
        limit: data.limit ?? null,
        remaining: data.limit_remaining ?? null,
        usage: data.usage ?? 0,
        usageDaily: data.usage_daily ?? 0,
        usageWeekly: data.usage_weekly ?? 0,
        usageMonthly: data.usage_monthly ?? 0,
        limitReset: data.limit_reset ?? null,
        includeByokInLimit: Boolean(data.include_byok_in_limit),
        isFreeTier: Boolean(data.is_free_tier),
        keyPreview: maskKey(config.key),
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
        limit: null,
        remaining: 0,
        usage: 0,
        usageDaily: 0,
        usageWeekly: 0,
        usageMonthly: 0,
        limitReset: null,
        includeByokInLimit: false,
        isFreeTier: false,
        keyPreview: maskKey(config.key),
        status: 'error',
        error: errorMessage,
        updatedAt: Date.now()
    };
}

async function fetchKeyStatus(config) {
    const response = await fetch(`${OPENROUTER_BASE_URL}/key`, {
        method: 'GET',
        headers: buildHeaders(config.key)
    });

    const text = await response.text();
    let payload = null;

    try {
        payload = text ? JSON.parse(text) : null;
    } catch {
        payload = null;
    }

    if (!response.ok) {
        const errorMessage = payload?.error?.message || payload?.message || `OpenRouter key check failed (${response.status})`;
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
            limit: null,
            remaining: null,
            usage: 0,
            usageDaily: 0,
            usageWeekly: 0,
            usageMonthly: 0,
            limitReset: null,
            includeByokInLimit: false,
            isFreeTier: false,
            keyPreview: maskKey(config.key),
            status: 'unknown',
            error: null,
            updatedAt: 0
        };
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
        return getCachedStatuses();
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
        return statuses;
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
        return getCachedStatuses();
    }).finally(() => {
        state.pendingRefresh = null;
    });

    return state.pendingRefresh;
}

export function getBestStatus(statuses = getCachedStatuses()) {
    const healthy = statuses
        .filter((status) => status.status === 'ok')
        .sort((left, right) => {
            const remainingDiff = compareRemaining(left.remaining, right.remaining);
            if (remainingDiff !== 0) {
                return remainingDiff * -1;
            }

            return right.updatedAt - left.updatedAt;
        });

    return healthy[0] || null;
}

function getRankedConfigs(statuses, configs) {
    const statusById = new Map(statuses.map((status) => [status.id, status]));

    return [...configs].sort((left, right) => {
        const leftStatus = statusById.get(left.id);
        const rightStatus = statusById.get(right.id);
        if (leftStatus && rightStatus) {
            const comparison = compareRemaining(leftStatus.remaining, rightStatus.remaining);
            if (comparison !== 0) {
                return comparison * -1;
            }
        } else if (rightStatus) {
            return 1;
        } else if (leftStatus) {
            return -1;
        }

        return left.envName.localeCompare(right.envName);
    });
}

function updateStatusFromUsage(keyId, usageCost) {
    const state = getState();
    const current = state.statuses.get(keyId);

    if (!current || current.remaining === null || usageCost === null || usageCost === undefined) {
        return;
    }

    state.statuses.set(keyId, {
        ...current,
        remaining: Math.max(0, Number(current.remaining) - Number(usageCost)),
        usage: Number(current.usage || 0) + Number(usageCost),
        updatedAt: Date.now()
    });
}

function markStatusUnavailable(keyId, message) {
    const state = getState();
    const current = state.statuses.get(keyId);

    if (!current) {
        return;
    }

    state.statuses.set(keyId, {
        ...current,
        remaining: 0,
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

export function buildStatusResponse(statuses = getCachedStatuses()) {
    const state = getState();
    const bestKey = getBestStatus(statuses);
    const healthyKeyCount = statuses.filter((status) => status.status === 'ok').length;

    return {
        provider: 'openrouter',
        strategy: 'highest_remaining_credits',
        configuredKeyCount: statuses.length,
        healthyKeyCount,
        bestKey,
        lastRefreshAt: state.lastFullRefreshAt || null,
        stale: !state.lastFullRefreshAt || Date.now() - state.lastFullRefreshAt > FULL_REFRESH_TTL_MS,
        keys: statuses
    };
}

export async function ensureFreshStatuses() {
    const state = getState();
    const shouldRefresh = !state.lastFullRefreshAt || Date.now() - state.lastFullRefreshAt > STATUS_TTL_MS;

    if (shouldRefresh) {
        return refreshAllKeyStatuses({ force: true });
    }

    return getCachedStatuses();
}

export async function forwardChatCompletion(rawBody) {
    const configs = getConfiguredKeys();
    if (!configs.length) {
        return {
            ok: false,
            status: 500,
            bodyText: JSON.stringify({ error: 'Brak skonfigurowanych kluczy OPENROUTER_KEY_* lub OPENROUTER_KEYS.' }),
            headers: { 'content-type': 'application/json; charset=utf-8' },
            selectedKey: null
        };
    }

    const payload = getRequestPayload(rawBody);
    if (!payload || (!Array.isArray(payload.messages) && typeof payload.prompt !== 'string')) {
        return {
            ok: false,
            status: 400,
            bodyText: JSON.stringify({ error: 'Body musi zawierać messages[] albo prompt.' }),
            headers: { 'content-type': 'application/json; charset=utf-8' },
            selectedKey: null
        };
    }

    const statuses = await ensureFreshStatuses();
    const rankedConfigs = getRankedConfigs(statuses, configs);
    const errors = [];

    for (const config of rankedConfigs) {
        const selectedStatus = getCachedStatuses().find((entry) => entry.id === config.id) || null;

        try {
            const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: buildHeaders(config.key),
                body: JSON.stringify(payload)
            });

            const bodyText = await response.text();
            const headers = {
                'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8'
            };

            if (!response.ok) {
                let errorMessage = `OpenRouter request failed (${response.status})`;

                try {
                    const parsed = bodyText ? JSON.parse(bodyText) : null;
                    errorMessage = parsed?.error?.message || parsed?.message || errorMessage;
                } catch {
                    if (bodyText) {
                        errorMessage = bodyText;
                    }
                }

                if ([401, 402, 429].includes(response.status)) {
                    markStatusUnavailable(config.id, errorMessage);
                    errors.push({ key: config.envName, status: response.status, message: errorMessage });
                    continue;
                }

                return {
                    ok: false,
                    status: response.status,
                    bodyText,
                    headers,
                    selectedKey: selectedStatus
                };
            }

            try {
                const parsed = bodyText ? JSON.parse(bodyText) : null;
                updateStatusFromUsage(config.id, parsed?.usage?.cost);
            } catch {
                // Ignore optimistic cache updates for non-JSON responses.
            }

            return {
                ok: true,
                status: response.status,
                bodyText,
                headers,
                selectedKey: selectedStatus
            };
        } catch (error) {
            markStatusUnavailable(config.id, error.message);
            errors.push({ key: config.envName, status: 500, message: error.message });
        }
    }

    return {
        ok: false,
        status: 503,
        bodyText: JSON.stringify({
            error: 'Zaden klucz nie mogl obsluzyc zapytania.',
            attempts: errors
        }),
        headers: { 'content-type': 'application/json; charset=utf-8' },
        selectedKey: null
    };
}

export function validateAppPassword(req) {
    const appPassword = process.env.APP_PASSWORD;
    const clientPassword = req.headers['x-app-password'];

    if (!appPassword) {
        return null;
    }

    if (clientPassword !== appPassword) {
        return { error: 'Brak dostepu. Bledne haslo.' };
    }

    return null;
}