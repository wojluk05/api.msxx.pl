import { randomUUID } from 'node:crypto';

const DEFAULT_SESSION_TTL_SECONDS = Math.max(300, Number(process.env.STREAM_SESSION_TTL_SECONDS || 1_800));
const DEFAULT_SESSION_TTL_MS = DEFAULT_SESSION_TTL_SECONDS * 1_000;
const MAX_STREAM_SESSIONS = Math.max(10, Number(process.env.MAX_STREAM_SESSIONS || 200));
const CLEANUP_INTERVAL_MS = Math.max(30_000, Number(process.env.STREAM_SESSION_CLEANUP_INTERVAL_MS || 60_000));

function getStore() {
    if (!globalThis.__remoteStreamSessionStore) {
        const store = {
            sessions: new Map(),
            cleanupTimer: null
        };

        if (typeof setInterval === 'function') {
            store.cleanupTimer = setInterval(() => {
                pruneExpiredSessions(store);
            }, CLEANUP_INTERVAL_MS);

            if (typeof store.cleanupTimer.unref === 'function') {
                store.cleanupTimer.unref();
            }
        }

        globalThis.__remoteStreamSessionStore = store;
    }

    return globalThis.__remoteStreamSessionStore;
}

function isExpired(session, now = Date.now()) {
    return !session || session.expiresAt <= now;
}

function enforceSessionLimit(store = getStore()) {
    if (store.sessions.size <= MAX_STREAM_SESSIONS) {
        return;
    }

    const removable = [...store.sessions.values()]
        .sort((left, right) => {
            if (left.lastAccessAt !== right.lastAccessAt) {
                return left.lastAccessAt - right.lastAccessAt;
            }

            return left.createdAt - right.createdAt;
        })
        .slice(0, store.sessions.size - MAX_STREAM_SESSIONS);

    removable.forEach((session) => {
        store.sessions.delete(session.id);
    });
}

function findReusableAsset(session, assetData) {
    if (!assetData.parentAssetId || assetData.playlistEntryIndex === null || assetData.playlistEntryIndex === undefined) {
        return null;
    }

    return [...session.assets.values()].find((asset) => {
        return asset.parentAssetId === assetData.parentAssetId
            && asset.playlistEntryIndex === assetData.playlistEntryIndex
            && asset.kind === assetData.kind;
    }) || null;
}

export function pruneExpiredSessions(store = getStore(), now = Date.now()) {
    [...store.sessions.values()].forEach((session) => {
        if (isExpired(session, now)) {
            store.sessions.delete(session.id);
        }
    });

    enforceSessionLimit(store);
}

export function touchStreamSession(session) {
    const now = Date.now();
    session.lastAccessAt = now;
    session.expiresAt = now + session.ttlMs;
    return session;
}

export function createStreamSession(data = {}) {
    const ttlMs = Math.max(60_000, Number(data.ttlMs || DEFAULT_SESSION_TTL_MS));
    const createdAt = Date.now();
    const session = {
        id: data.id || randomUUID(),
        sourceUrl: data.sourceUrl || null,
        hostType: data.hostType || 'generic',
        userAgent: data.userAgent || null,
        ttlMs,
        createdAt,
        lastAccessAt: createdAt,
        expiresAt: createdAt + ttlMs,
        cookieJar: Array.isArray(data.cookieJar) ? data.cookieJar : [],
        assets: new Map(),
        assetCounter: 0,
        mediaType: data.mediaType || null,
        rootPageUrl: data.rootPageUrl || null,
        resolution: data.resolution || null,
        lastDebug: data.lastDebug || null,
        pendingResolve: null
    };

    const store = getStore();
    pruneExpiredSessions(store);
    store.sessions.set(session.id, session);
    enforceSessionLimit(store);
    return session;
}

export function deleteStreamSession(ticket) {
    const store = getStore();
    store.sessions.delete(ticket);
}

export function getStreamSession(ticket, options = {}) {
    const { touch = true } = options;
    const store = getStore();
    pruneExpiredSessions(store);

    const session = store.sessions.get(ticket);
    if (!session) {
        return null;
    }

    if (isExpired(session)) {
        store.sessions.delete(ticket);
        return null;
    }

    return touch ? touchStreamSession(session) : session;
}

export function getRemainingSessionTtlSeconds(session, now = Date.now()) {
    return Math.max(0, Math.ceil((session.expiresAt - now) / 1_000));
}

export function upsertStreamAsset(session, assetData) {
    const now = Date.now();
    const assetId = assetData.id || findReusableAsset(session, assetData)?.id || `asset_${++session.assetCounter}`;
    const existing = session.assets.get(assetId);
    const createdAt = existing?.createdAt || now;
    const asset = {
        ...existing,
        ...assetData,
        id: assetId,
        createdAt,
        updatedAt: now,
        parentAssetId: assetData.parentAssetId || null,
        playlistEntryIndex: assetData.playlistEntryIndex ?? null,
        lineHint: assetData.lineHint || null
    };

    session.assets.set(assetId, asset);
    return asset;
}

export function getStreamAsset(session, assetId) {
    return session.assets.get(assetId) || null;
}

export function listSessionCookieNames(session) {
    return [...new Set((session.cookieJar || []).map((cookie) => cookie.name).filter(Boolean))].sort();
}