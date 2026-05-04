import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
    createStreamSession,
    deleteStreamSession,
    getRemainingSessionTtlSeconds,
    getStreamAsset,
    getStreamSession,
    listSessionCookieNames,
    touchStreamSession,
    upsertStreamAsset
} from './stream-session-store.js';

const DEFAULT_USER_AGENT = process.env.STREAM_RESOLVER_USER_AGENT
    || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
const STREAM_CORS_ALLOW_ORIGIN = process.env.STREAM_CORS_ALLOW_ORIGIN || '*';
const STREAM_CORS_ALLOW_HEADERS = process.env.STREAM_CORS_ALLOW_HEADERS || 'Range, Content-Type, x-api-key';
const STREAM_CORS_EXPOSE_HEADERS = 'Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified';
const MAX_RESOLVE_DEPTH = Math.max(1, Number(process.env.STREAM_RESOLVE_MAX_DEPTH || 4));
const MAX_DIRECT_CANDIDATES = Math.max(1, Number(process.env.STREAM_MAX_DIRECT_CANDIDATES || 12));
const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const PLAYLIST_ACCEPT = 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain;q=0.8,*/*;q=0.6';
const BINARY_ACCEPT = '*/*';

function getSingleValue(value) {
    return Array.isArray(value) ? value[0] : value;
}

function isTruthy(value) {
    const normalized = String(getSingleValue(value) || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'debug'].includes(normalized);
}

function recordEvent(debugState, value) {
    if (!debugState || !value) {
        return;
    }

    if (!debugState.detectedEvents.includes(value)) {
        debugState.detectedEvents.push(value);
    }
}

function sanitizeDebugUrl(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return url;
    }
}

function createControlledError(code, message, status = 502, debug = {}) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.debug = debug;
    return error;
}

function normalizeTargetUrl(rawValue) {
    const value = String(getSingleValue(rawValue) || '').trim();
    if (!value) {
        throw createControlledError('INVALID_URL', 'Parametr url jest wymagany.', 400);
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(value);
    } catch {
        throw createControlledError('INVALID_URL', 'Parametr url musi byc poprawnym adresem http lub https.', 400);
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw createControlledError('INVALID_URL', 'Parametr url musi byc poprawnym adresem http lub https.', 400);
    }

    return parsedUrl.toString();
}

function getHeaderValue(req, headerName) {
    const value = req.headers?.[headerName];
    if (Array.isArray(value)) {
        return value[0];
    }

    if (typeof value === 'string' && value.includes(',')) {
        return value.split(',')[0].trim();
    }

    return value;
}

function getRequestBaseUrl(req) {
    const protocol = getHeaderValue(req, 'x-forwarded-proto') || 'http';
    const host = getHeaderValue(req, 'x-forwarded-host') || getHeaderValue(req, 'host') || 'localhost:3000';
    return `${protocol}://${host}`;
}

function buildPlaybackUrl(req, ticket, assetId = null) {
    const url = new URL('/stream', getRequestBaseUrl(req));
    url.searchParams.set('ticket', ticket);

    if (assetId && assetId !== 'root') {
        url.searchParams.set('asset', assetId);
    }

    return url.toString();
}

function getUrlOrigin(url) {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

function detectHostType(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        if (/dood|d0000d|dooood/.test(hostname)) {
            return 'dood';
        }

        if (/myvidplay|vidplay/.test(hostname)) {
            return 'myvidplay';
        }

        return hostname;
    } catch {
        return 'generic';
    }
}

function isPlaylistLikeUrl(url) {
    return /\.m3u8(?:[?#]|$)/i.test(url);
}

function isFileLikeUrl(url) {
    return /\.(?:mp4|m4v|mov|avi|webm)(?:[?#]|$)/i.test(url);
}

function inferMediaTypeFromUrl(url) {
    if (isPlaylistLikeUrl(url)) {
        return 'hls';
    }

    if (isFileLikeUrl(url)) {
        return 'file';
    }

    return null;
}

function decodeEscapedUrl(rawValue) {
    return String(rawValue || '')
        .replace(/\\u002F/gi, '/')
        .replace(/\\x2f/gi, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/gi, '&');
}

function toAbsoluteUrl(rawValue, baseUrl) {
    const candidate = decodeEscapedUrl(rawValue).trim();
    if (!candidate) {
        return null;
    }

    try {
        return new URL(candidate, baseUrl).toString();
    } catch {
        return null;
    }
}

function looksLikeHlsPlaylist(text) {
    return String(text || '').trimStart().startsWith('#EXTM3U');
}

function looksLikeHtml(text) {
    return /<html|<!doctype html|<body|<script/i.test(String(text || ''));
}

function hasFailureMarker(text) {
    return /(error_wrong_ip|reload)/i.test(String(text || ''));
}

function getContentType(response) {
    return (response.headers.get('content-type') || '').toLowerCase();
}

function isPlaylistContentType(contentType) {
    return /mpegurl|apple\.mpegurl/.test(contentType);
}

function isHtmlContentType(contentType) {
    return /text\/html|application\/xhtml\+xml/.test(contentType);
}

function isSuspiciousBinaryContentType(contentType) {
    if (!contentType) {
        return true;
    }

    if (isHtmlContentType(contentType)) {
        return true;
    }

    return /text\/plain|text\/|application\/json|application\/xml|text\/xml/.test(contentType);
}

function buildCookieDomainMatch(hostname, domain) {
    const normalizedHost = hostname.toLowerCase();
    const normalizedDomain = domain.toLowerCase();
    return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function getResponseSetCookieHeaders(response) {
    if (response.headers && typeof response.headers.getSetCookie === 'function') {
        return response.headers.getSetCookie();
    }

    const singleHeader = response.headers.get('set-cookie');
    return singleHeader ? [singleHeader] : [];
}

function parseSetCookieHeader(header, responseUrl) {
    const parts = String(header || '').split(';').map((part) => part.trim()).filter(Boolean);
    if (!parts.length) {
        return null;
    }

    const separatorIndex = parts[0].indexOf('=');
    if (separatorIndex <= 0) {
        return null;
    }

    let hostname = null;
    try {
        hostname = new URL(responseUrl).hostname.toLowerCase();
    } catch {
        hostname = null;
    }

    const cookie = {
        name: parts[0].slice(0, separatorIndex).trim(),
        value: parts[0].slice(separatorIndex + 1).trim(),
        domain: hostname,
        path: '/',
        secure: false,
        expiresAt: null
    };

    parts.slice(1).forEach((part) => {
        const [rawKey, ...rest] = part.split('=');
        const key = rawKey.trim().toLowerCase();
        const value = rest.join('=').trim();

        if (key === 'domain' && value) {
            cookie.domain = value.replace(/^\./, '').toLowerCase();
        }

        if (key === 'path' && value) {
            cookie.path = value;
        }

        if (key === 'max-age') {
            const seconds = Number(value);
            if (Number.isFinite(seconds)) {
                cookie.expiresAt = Date.now() + (seconds * 1_000);
            }
        }

        if (key === 'expires') {
            const timestamp = Date.parse(value);
            if (!Number.isNaN(timestamp)) {
                cookie.expiresAt = timestamp;
            }
        }

        if (key === 'secure') {
            cookie.secure = true;
        }
    });

    return cookie.name ? cookie : null;
}

function storeResponseCookies(session, response, responseUrl) {
    getResponseSetCookieHeaders(response).forEach((header) => {
        const cookie = parseSetCookieHeader(header, responseUrl);
        if (!cookie || !cookie.name) {
            return;
        }

        session.cookieJar = (session.cookieJar || []).filter((entry) => {
            return !(entry.name === cookie.name && entry.domain === cookie.domain && entry.path === cookie.path);
        });

        if (cookie.expiresAt && cookie.expiresAt <= Date.now()) {
            return;
        }

        session.cookieJar.push(cookie);
    });
}

function buildCookieHeader(session, requestUrl) {
    let parsedUrl;
    try {
        parsedUrl = new URL(requestUrl);
    } catch {
        return '';
    }

    const pathname = parsedUrl.pathname || '/';
    const now = Date.now();
    session.cookieJar = (session.cookieJar || []).filter((cookie) => !cookie.expiresAt || cookie.expiresAt > now);

    return session.cookieJar
        .filter((cookie) => {
            if (!cookie.domain || !buildCookieDomainMatch(parsedUrl.hostname, cookie.domain)) {
                return false;
            }

            if (cookie.secure && parsedUrl.protocol !== 'https:') {
                return false;
            }

            return pathname.startsWith(cookie.path || '/');
        })
        .sort((left, right) => (right.path || '/').length - (left.path || '/').length)
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join('; ');
}

async function fetchWithSession(session, url, options = {}) {
    touchStreamSession(session);

    const headers = new Headers(options.headers || {});
    if (!headers.has('user-agent')) {
        headers.set('user-agent', session.userAgent || DEFAULT_USER_AGENT);
    }

    if (!headers.has('accept-language')) {
        headers.set('accept-language', 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7');
    }

    if (options.accept && !headers.has('accept')) {
        headers.set('accept', options.accept);
    }

    if (options.referer) {
        headers.set('referer', options.referer);
    }

    if (options.origin) {
        headers.set('origin', options.origin);
    }

    const cookieHeader = buildCookieHeader(session, url);
    if (cookieHeader && !headers.has('cookie')) {
        headers.set('cookie', cookieHeader);
    }

    const response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body,
        redirect: options.redirect || 'follow'
    });

    storeResponseCookies(session, response, response.url || url);
    return response;
}

async function readResponsePreview(response, limit = 4096) {
    if (!response.body) {
        return '';
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let total = 0;

    try {
        while (total < limit) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            total += value.byteLength;
            text += decoder.decode(value, { stream: true });
        }

        text += decoder.decode();
    } finally {
        try {
            await reader.cancel();
        } catch {
            // Ignore stream cancellation errors from preview reads.
        }
    }

    return text;
}

async function createValidatedBinaryStream(response) {
    if (!response.body) {
        return Readable.from([]);
    }

    const contentType = getContentType(response);
    if (!isSuspiciousBinaryContentType(contentType)) {
        return Readable.fromWeb(response.body);
    }

    const reader = response.body.getReader();
    const firstChunk = await reader.read();
    const initialBuffer = firstChunk.done ? Buffer.alloc(0) : Buffer.from(firstChunk.value);
    const previewText = initialBuffer.toString('utf8', 0, Math.min(initialBuffer.length, 512));

    if (looksLikeHlsPlaylist(previewText)) {
        throw createControlledError(
            'STREAM_NOT_STABLE',
            'Upstream zwrocil playliste HLS zamiast binarnego media.',
            502,
            { preview: previewText.slice(0, 160) }
        );
    }

    if (looksLikeHtml(previewText) || hasFailureMarker(previewText)) {
        throw createControlledError(
            'STREAM_NOT_STABLE',
            'Upstream zwrocil HTML albo komunikat anti-bot zamiast media.',
            502,
            { preview: previewText.slice(0, 160) }
        );
    }

    return Readable.from((async function* () {
        if (initialBuffer.length) {
            yield initialBuffer;
        }

        while (true) {
            const nextChunk = await reader.read();
            if (nextChunk.done) {
                break;
            }

            yield Buffer.from(nextChunk.value);
        }
    })());
}

function addCandidate(candidateList, seen, rawUrl, baseUrl, mediaType, referer) {
    const absoluteUrl = toAbsoluteUrl(rawUrl, baseUrl);
    if (!absoluteUrl || !/^https?:\/\//i.test(absoluteUrl)) {
        return;
    }

    const key = `${mediaType || 'unknown'}:${absoluteUrl}`;
    if (seen.has(key)) {
        return;
    }

    seen.add(key);
    candidateList.push({
        url: absoluteUrl,
        mediaType: mediaType || inferMediaTypeFromUrl(absoluteUrl) || 'file',
        referer,
        origin: getUrlOrigin(referer),
        pageUrl: baseUrl
    });
}

function extractMediaCandidates(html, baseUrl, referer) {
    const candidates = [];
    const seen = new Set();
    const patterns = [
        /https?:\\?\/\\?\/[^"'<>\s]+(?:\.m3u8(?:[^"'<>\s]*)?|\.mp4(?:[^"'<>\s]*)?)/gi,
        /(?:file|src|source|url)\s*[:=]\s*["']([^"']+)["']/gi,
        /["']([^"']+\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/gi
    ];

    for (const match of html.matchAll(patterns[0])) {
        addCandidate(candidates, seen, match[0], baseUrl, inferMediaTypeFromUrl(match[0]), referer);
    }

    for (const match of html.matchAll(patterns[1])) {
        if (/\.m3u8(?:[?#]|$)|\.mp4(?:[?#]|$)/i.test(match[1])) {
            addCandidate(candidates, seen, match[1], baseUrl, inferMediaTypeFromUrl(match[1]), referer);
        }
    }

    for (const match of html.matchAll(patterns[2])) {
        addCandidate(candidates, seen, match[1], baseUrl, inferMediaTypeFromUrl(match[1]), referer);
    }

    return candidates.sort((left, right) => {
        if (left.mediaType === right.mediaType) {
            return left.url.localeCompare(right.url);
        }

        return left.mediaType === 'hls' ? -1 : 1;
    });
}

function extractIframeUrls(html, baseUrl) {
    const matches = [...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)];

    return matches
        .map((match) => toAbsoluteUrl(match[1], baseUrl))
        .filter(Boolean)
        .sort((left, right) => {
            const leftHost = detectHostType(left);
            const rightHost = detectHostType(right);

            if (leftHost !== 'generic' && rightHost === 'generic') {
                return -1;
            }

            if (rightHost !== 'generic' && leftHost === 'generic') {
                return 1;
            }

            return left.localeCompare(right);
        });
}

function extractPassMd5Descriptor(html, pageUrl) {
    const passMatch = html.match(/(?:https?:\/\/[^"'\s]+)?\/pass_md5\/[^"'\s]+/i);
    if (!passMatch) {
        return null;
    }

    const token = html.match(/[?&]token=([a-z0-9._-]+)/i)?.[1]
        || html.match(/token\s*[:=]\s*["']([a-z0-9._-]+)["']/i)?.[1]
        || null;
    const expiry = html.match(/[?&]expiry=([0-9]+)/i)?.[1]
        || html.match(/expiry\s*[:=]\s*["']?([0-9]{6,})/i)?.[1]
        || null;

    return {
        passUrl: toAbsoluteUrl(passMatch[0], pageUrl),
        token,
        expiry
    };
}

async function verifyCandidate(session, candidate, debugState) {
    const guessedMediaType = candidate.mediaType || inferMediaTypeFromUrl(candidate.url) || 'file';
    const headers = new Headers();

    if (guessedMediaType === 'file') {
        headers.set('range', 'bytes=0-1');
    }

    const response = await fetchWithSession(session, candidate.url, {
        headers,
        referer: candidate.referer,
        origin: candidate.origin,
        accept: guessedMediaType === 'hls' ? PLAYLIST_ACCEPT : BINARY_ACCEPT
    });
    const finalUrl = response.url || candidate.url;
    const contentType = getContentType(response);

    if (!response.ok) {
        const preview = await readResponsePreview(response);
        if (hasFailureMarker(preview)) {
            recordEvent(debugState, 'error_wrong_ip_or_reload');
        }

        return null;
    }

    if (guessedMediaType === 'hls' || isPlaylistContentType(contentType) || isPlaylistLikeUrl(finalUrl)) {
        const playlistText = await response.text();
        if (!looksLikeHlsPlaylist(playlistText)) {
            if (hasFailureMarker(playlistText) || looksLikeHtml(playlistText)) {
                recordEvent(debugState, 'html_instead_of_playlist');
            }

            return null;
        }

        debugState.playlistVerified = true;
        return {
            mediaType: 'hls',
            url: finalUrl,
            referer: candidate.referer || candidate.pageUrl,
            origin: candidate.origin || getUrlOrigin(candidate.referer || candidate.pageUrl),
            pageUrl: candidate.pageUrl,
            contentType: contentType || 'application/vnd.apple.mpegurl',
            rangeSupported: false
        };
    }

    const preview = await readResponsePreview(response, 512);
    if (looksLikeHtml(preview) || hasFailureMarker(preview)) {
        recordEvent(debugState, 'html_instead_of_media');
        return null;
    }

    debugState.rangeSupported = response.status === 206 || /^bytes$/i.test(response.headers.get('accept-ranges') || '');
    return {
        mediaType: 'file',
        url: finalUrl,
        referer: candidate.referer || candidate.pageUrl,
        origin: candidate.origin || getUrlOrigin(candidate.referer || candidate.pageUrl),
        pageUrl: candidate.pageUrl,
        contentType: contentType || 'application/octet-stream',
        rangeSupported: debugState.rangeSupported
    };
}

async function resolveDoodCandidate(session, pageUrl, html, debugState) {
    const descriptor = extractPassMd5Descriptor(html, pageUrl);
    if (!descriptor?.passUrl) {
        return null;
    }

    debugState.passMd5Used = true;
    const response = await fetchWithSession(session, descriptor.passUrl, {
        referer: pageUrl,
        origin: getUrlOrigin(pageUrl),
        accept: BINARY_ACCEPT
    });
    const body = (await response.text()).trim();
    if (!response.ok || !body || /^reload$/i.test(body)) {
        recordEvent(debugState, 'pass_md5_reload');
        return null;
    }

    const resolvedUrl = toAbsoluteUrl(body, descriptor.passUrl) || toAbsoluteUrl(body, pageUrl);
    if (!resolvedUrl) {
        return null;
    }

    const mediaUrl = new URL(resolvedUrl);
    if (descriptor.token && !mediaUrl.searchParams.has('token')) {
        mediaUrl.searchParams.set('token', descriptor.token);
    }

    if (descriptor.expiry && !mediaUrl.searchParams.has('expiry')) {
        mediaUrl.searchParams.set('expiry', descriptor.expiry);
    }

    return verifyCandidate(session, {
        url: mediaUrl.toString(),
        mediaType: inferMediaTypeFromUrl(mediaUrl.toString()) || 'file',
        referer: pageUrl,
        origin: getUrlOrigin(pageUrl),
        pageUrl
    }, debugState);
}

async function resolveMediaFromPage(session, pageUrl, debugState, depth = 0, referer = null) {
    if (depth > MAX_RESOLVE_DEPTH) {
        throw createControlledError(
            'STREAM_NOT_STABLE',
            'Przekroczono limit krokow wymaganych do resolve streamu.',
            502,
            { visitedPages: debugState.visitedPages }
        );
    }

    const response = await fetchWithSession(session, pageUrl, {
        referer,
        origin: getUrlOrigin(referer),
        accept: HTML_ACCEPT
    });
    const finalUrl = response.url || pageUrl;
    session.rootPageUrl = finalUrl;
    debugState.host = detectHostType(finalUrl);

    if (!debugState.visitedPages.includes(sanitizeDebugUrl(finalUrl))) {
        debugState.visitedPages.push(sanitizeDebugUrl(finalUrl));
    }

    const contentType = getContentType(response);
    if (!response.ok) {
        const preview = await readResponsePreview(response);
        throw createControlledError(
            'STREAM_NOT_STABLE',
            `Host zwrocil status ${response.status} podczas resolve.`,
            502,
            {
                visitedPages: debugState.visitedPages,
                preview: preview.slice(0, 160)
            }
        );
    }

    if (isPlaylistContentType(contentType) || isPlaylistLikeUrl(finalUrl)) {
        const playlistText = await response.text();
        if (looksLikeHlsPlaylist(playlistText)) {
            debugState.playlistVerified = true;
            return {
                mediaType: 'hls',
                url: finalUrl,
                referer: referer || finalUrl,
                origin: getUrlOrigin(referer || finalUrl),
                pageUrl: finalUrl,
                contentType: contentType || 'application/vnd.apple.mpegurl',
                rangeSupported: false
            };
        }
    }

    if (!isHtmlContentType(contentType) && !/text\//.test(contentType) && !/application\/javascript/.test(contentType) && !/json/.test(contentType)) {
        return {
            mediaType: 'file',
            url: finalUrl,
            referer: referer || finalUrl,
            origin: getUrlOrigin(referer || finalUrl),
            pageUrl: finalUrl,
            contentType: contentType || 'application/octet-stream',
            rangeSupported: /^bytes$/i.test(response.headers.get('accept-ranges') || '')
        };
    }

    const html = await response.text();
    if (hasFailureMarker(html)) {
        recordEvent(debugState, 'error_wrong_ip_or_reload');
    }

    const doodCandidate = await resolveDoodCandidate(session, finalUrl, html, debugState);
    if (doodCandidate) {
        return doodCandidate;
    }

    const candidates = extractMediaCandidates(html, finalUrl, finalUrl).slice(0, MAX_DIRECT_CANDIDATES);
    for (const candidate of candidates) {
        const resolvedCandidate = await verifyCandidate(session, candidate, debugState);
        if (resolvedCandidate) {
            return resolvedCandidate;
        }
    }

    const iframeUrls = extractIframeUrls(html, finalUrl);
    for (const iframeUrl of iframeUrls) {
        try {
            const nestedResolution = await resolveMediaFromPage(session, iframeUrl, debugState, depth + 1, finalUrl);
            if (nestedResolution) {
                return nestedResolution;
            }
        } catch (error) {
            recordEvent(debugState, error.code || 'nested_iframe_failed');
        }
    }

    throw createControlledError(
        'STREAM_NOT_STABLE',
        'Host wymaga tej samej sesji/IP i nie udalo sie utrzymac stabilnego streamu.',
        502,
        {
            visitedPages: debugState.visitedPages,
            detectedEvents: debugState.detectedEvents
        }
    );
}

function createDebugState(session) {
    return {
        host: session.hostType,
        mediaType: null,
        passMd5Used: false,
        cookies: listSessionCookieNames(session),
        playlistRewritten: false,
        playlistVerified: false,
        rangeSupported: false,
        visitedPages: [],
        detectedEvents: []
    };
}

function normalizeLineHint(rawUri) {
    const decoded = decodeEscapedUrl(rawUri).trim();

    try {
        const parsed = new URL(decoded);
        return `${parsed.pathname.toLowerCase()}|${[...parsed.searchParams.keys()].sort().join(',')}`;
    } catch {
        return decoded.toLowerCase();
    }
}

function getDirectiveKind(tagName, rawUri) {
    if (tagName === 'EXT-X-KEY') {
        return 'key';
    }

    if (tagName === 'EXT-X-MAP') {
        return 'map';
    }

    if (tagName === 'EXT-X-MEDIA' || tagName === 'EXT-X-I-FRAME-STREAM-INF') {
        return 'playlist';
    }

    return isPlaylistLikeUrl(rawUri) ? 'playlist' : 'segment';
}

function parseHlsPlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const entries = [];
    let uriEntryIndex = 0;
    let expectVariantPlaylist = false;

    lines.forEach((line, lineNumber) => {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }

        if (trimmed.startsWith('#EXT-X-STREAM-INF')) {
            expectVariantPlaylist = true;
            return;
        }

        if (trimmed.startsWith('#')) {
            const tagName = trimmed.slice(1).split(':')[0];
            const uriMatch = line.match(/URI="([^"]+)"/i);
            if (uriMatch) {
                const rawUri = uriMatch[1];
                entries.push({
                    entryIndex: uriEntryIndex++,
                    kind: getDirectiveKind(tagName, rawUri),
                    rawUri,
                    absoluteUrl: toAbsoluteUrl(rawUri, baseUrl),
                    lineNumber,
                    rewriteType: 'attribute',
                    originalLine: line,
                    lineHint: normalizeLineHint(rawUri)
                });
            }

            return;
        }

        const rawUri = trimmed;
        entries.push({
            entryIndex: uriEntryIndex++,
            kind: expectVariantPlaylist || isPlaylistLikeUrl(rawUri) ? 'playlist' : 'segment',
            rawUri,
            absoluteUrl: toAbsoluteUrl(rawUri, baseUrl),
            lineNumber,
            rewriteType: 'line',
            originalLine: line,
            lineHint: normalizeLineHint(rawUri)
        });
        expectVariantPlaylist = false;
    });

    return {
        lines,
        entries: entries.filter((entry) => entry.absoluteUrl)
    };
}

function createRequestState(debugEnabled) {
    return {
        debugEnabled,
        rootResolution: null,
        playlistSnapshots: new Map()
    };
}

function invalidateRequestState(requestState) {
    requestState.rootResolution = null;
    requestState.playlistSnapshots.clear();
}

async function resolveSessionMedia(session, debugState, requestState) {
    if (requestState?.rootResolution) {
        return requestState.rootResolution;
    }

    const runResolve = async () => {
        const currentDebugState = debugState || createDebugState(session);
        currentDebugState.host = detectHostType(session.sourceUrl);
        const resolved = await resolveMediaFromPage(session, session.sourceUrl, currentDebugState);

        session.hostType = currentDebugState.host || detectHostType(resolved.pageUrl || session.sourceUrl);
        session.mediaType = resolved.mediaType;
        session.rootPageUrl = resolved.pageUrl || session.rootPageUrl || session.sourceUrl;
        session.resolution = {
            ...resolved,
            resolvedAt: Date.now()
        };
        session.lastDebug = {
            host: session.hostType,
            mediaType: resolved.mediaType,
            passMd5Used: Boolean(currentDebugState.passMd5Used),
            cookies: listSessionCookieNames(session),
            playlistRewritten: Boolean(currentDebugState.playlistRewritten),
            rangeSupported: Boolean(currentDebugState.rangeSupported),
            playlistVerified: Boolean(currentDebugState.playlistVerified),
            visitedPages: currentDebugState.visitedPages,
            detectedEvents: currentDebugState.detectedEvents
        };

        upsertStreamAsset(session, {
            id: 'root',
            kind: resolved.mediaType === 'hls' ? 'playlist' : 'file',
            url: resolved.url,
            referer: resolved.referer,
            origin: resolved.origin,
            parentAssetId: null,
            playlistEntryIndex: null,
            lineHint: null
        });

        return session.resolution;
    };

    const promise = session.pendingResolve || runResolve().finally(() => {
        session.pendingResolve = null;
    });
    session.pendingResolve = promise;

    if (requestState) {
        requestState.rootResolution = promise;
    }

    return promise;
}

function getRootAsset(session) {
    return getStreamAsset(session, 'root');
}

async function resolveAssetTarget(session, asset, requestState) {
    if (!asset) {
        throw createControlledError('ASSET_NOT_FOUND', 'Nie znaleziono zasobu streamu dla tego ticketu.', 404);
    }

    if (asset.id === 'root') {
        const resolved = await resolveSessionMedia(session, null, requestState);
        return {
            ...asset,
            kind: resolved.mediaType === 'hls' ? 'playlist' : 'file',
            url: resolved.url,
            referer: resolved.referer,
            origin: resolved.origin
        };
    }

    if (!asset.parentAssetId) {
        return asset;
    }

    const parentAsset = getStreamAsset(session, asset.parentAssetId);
    const parentSnapshot = await loadPlaylistSnapshot(session, parentAsset, requestState);
    const matchingEntry = parentSnapshot.parsed.entries.find((entry) => {
        if (entry.entryIndex === asset.playlistEntryIndex) {
            return true;
        }

        return entry.kind === asset.kind && entry.lineHint === asset.lineHint;
    });

    if (!matchingEntry) {
        throw createControlledError(
            'STREAM_NOT_STABLE',
            'Nie udalo sie odswiezyc zasobu HLS w tej samej sesji.',
            502,
            { assetId: asset.id }
        );
    }

    return upsertStreamAsset(session, {
        ...asset,
        url: matchingEntry.absoluteUrl,
        referer: parentSnapshot.finalUrl,
        origin: getUrlOrigin(parentSnapshot.finalUrl),
        lineHint: matchingEntry.lineHint
    });
}

async function loadPlaylistSnapshot(session, asset, requestState) {
    if (!asset) {
        throw createControlledError('ASSET_NOT_FOUND', 'Nie znaleziono playlisty dla tego ticketu.', 404);
    }

    const cacheKey = asset.id;
    if (requestState.playlistSnapshots.has(cacheKey)) {
        return requestState.playlistSnapshots.get(cacheKey);
    }

    const snapshotPromise = (async () => {
        const target = await resolveAssetTarget(session, asset, requestState);
        const response = await fetchWithSession(session, target.url, {
            referer: target.referer,
            origin: target.origin,
            accept: PLAYLIST_ACCEPT
        });

        if (!response.ok) {
            const preview = await readResponsePreview(response);
            throw createControlledError(
                'STREAM_NOT_STABLE',
                `Upstream playlist zwrocil status ${response.status}.`,
                502,
                { preview: preview.slice(0, 160), assetId: asset.id }
            );
        }

        const text = await response.text();
        if (!looksLikeHlsPlaylist(text)) {
            throw createControlledError(
                'STREAM_NOT_STABLE',
                'Upstream zwrocil cos innego niz playlista HLS.',
                502,
                { preview: text.slice(0, 160), assetId: asset.id }
            );
        }

        const finalUrl = response.url || target.url;
        upsertStreamAsset(session, {
            ...asset,
            url: finalUrl,
            referer: target.referer,
            origin: target.origin
        });

        return {
            asset,
            finalUrl,
            contentType: getContentType(response) || 'application/vnd.apple.mpegurl',
            text,
            parsed: parseHlsPlaylist(text, finalUrl)
        };
    })();

    requestState.playlistSnapshots.set(cacheKey, snapshotPromise);
    return snapshotPromise;
}

function rewritePlaylistForClient(session, snapshot, req) {
    const rewrittenLines = [...snapshot.parsed.lines];

    snapshot.parsed.entries.forEach((entry) => {
        const asset = upsertStreamAsset(session, {
            kind: entry.kind,
            url: entry.absoluteUrl,
            referer: snapshot.finalUrl,
            origin: getUrlOrigin(snapshot.finalUrl),
            parentAssetId: snapshot.asset.id,
            playlistEntryIndex: entry.entryIndex,
            lineHint: entry.lineHint
        });
        const proxyUrl = buildPlaybackUrl(req, session.id, asset.id);

        if (entry.rewriteType === 'line') {
            rewrittenLines[entry.lineNumber] = proxyUrl;
            return;
        }

        rewrittenLines[entry.lineNumber] = entry.originalLine.replace(entry.rawUri, proxyUrl);
    });

    session.lastDebug = {
        ...(session.lastDebug || {}),
        playlistRewritten: true,
        cookies: listSessionCookieNames(session)
    };

    return rewrittenLines.join('\n');
}

function setErrorHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function toClientError(error, debugEnabled = false) {
    const status = error.status || 500;
    const body = {
        success: false,
        code: error.code || 'STREAM_ERROR',
        error: error.message || 'Wystapil nieoczekiwany blad streamu.'
    };

    if (debugEnabled && error.debug) {
        body.debug = error.debug;
    }

    return {
        status,
        body
    };
}

function buildResolveDebugPayload(session) {
    return {
        host: session.lastDebug?.host || session.hostType,
        mediaType: session.lastDebug?.mediaType || session.mediaType,
        passMd5Used: Boolean(session.lastDebug?.passMd5Used),
        cookies: listSessionCookieNames(session),
        playlistRewritten: Boolean(session.lastDebug?.playlistRewritten),
        rangeSupported: Boolean(session.lastDebug?.rangeSupported),
        playlistVerified: Boolean(session.lastDebug?.playlistVerified),
        visitedPages: session.lastDebug?.visitedPages || [],
        detectedEvents: session.lastDebug?.detectedEvents || []
    };
}

export function applyStreamCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', STREAM_CORS_ALLOW_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', STREAM_CORS_ALLOW_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', STREAM_CORS_EXPOSE_HEADERS);
    res.setHeader('Timing-Allow-Origin', STREAM_CORS_ALLOW_ORIGIN === '*' ? '*' : STREAM_CORS_ALLOW_ORIGIN);
    res.setHeader('Vary', 'Origin');
}

export function sendStreamOptions(res) {
    applyStreamCorsHeaders(res);
    res.status(204).end();
}

export async function resolveStableStream(req) {
    let sourceUrl;
    try {
        sourceUrl = normalizeTargetUrl(req.query?.url);
    } catch (error) {
        return toClientError(error, isTruthy(req.query?.debug));
    }

    const debugEnabled = isTruthy(req.query?.debug);
    const session = createStreamSession({
        sourceUrl,
        hostType: detectHostType(sourceUrl),
        userAgent: DEFAULT_USER_AGENT
    });

    try {
        const debugState = createDebugState(session);
        const resolved = await resolveSessionMedia(session, debugState, null);

        return {
            status: 200,
            body: {
                success: true,
                mediaType: resolved.mediaType,
                playbackUrl: buildPlaybackUrl(req, session.id),
                referer: session.rootPageUrl || resolved.pageUrl || sourceUrl,
                ttlSeconds: getRemainingSessionTtlSeconds(session),
                ...(debugEnabled ? { debug: buildResolveDebugPayload(session) } : {})
            }
        };
    } catch (error) {
        deleteStreamSession(session.id);
        return toClientError(error, debugEnabled);
    }
}

function setUpstreamResponseHeaders(res, response, options = {}) {
    const forwardedHeaders = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'cache-control',
        'etag',
        'last-modified',
        'content-disposition'
    ];

    forwardedHeaders.forEach((name) => {
        const value = response.headers.get(name);
        if (value) {
            res.setHeader(name, value);
        }
    });

    if (!response.headers.get('cache-control')) {
        res.setHeader('Cache-Control', 'no-store');
    }

    if (response.status === 206 && !response.headers.get('accept-ranges')) {
        res.setHeader('Accept-Ranges', 'bytes');
    }

    if (options.contentTypeOverride) {
        res.setHeader('Content-Type', options.contentTypeOverride);
    }
}

async function withSingleRefreshRetry(action) {
    const firstState = createRequestState(false);

    try {
        return await action(firstState);
    } catch (error) {
        if (error.code !== 'STREAM_NOT_STABLE') {
            throw error;
        }

        const retryState = createRequestState(false);
        invalidateRequestState(retryState);
        return action(retryState);
    }
}

async function fetchBinaryAsset(session, asset, req, requestState) {
    const target = await resolveAssetTarget(session, asset, requestState);
    const headers = new Headers();
    const rangeHeader = getHeaderValue(req, 'range');
    if (rangeHeader) {
        headers.set('range', rangeHeader);
    }

    const response = await fetchWithSession(session, target.url, {
        headers,
        referer: target.referer,
        origin: target.origin,
        accept: BINARY_ACCEPT
    });

    if (!response.ok && response.status !== 206) {
        const preview = await readResponsePreview(response);
        throw createControlledError(
            'STREAM_NOT_STABLE',
            `Upstream media zwrocil status ${response.status}.`,
            502,
            { preview: preview.slice(0, 160), assetId: asset.id }
        );
    }

    const stream = await createValidatedBinaryStream(response);
    session.lastDebug = {
        ...(session.lastDebug || {}),
        rangeSupported: response.status === 206 || /^bytes$/i.test(response.headers.get('accept-ranges') || '')
    };

    return {
        response,
        stream
    };
}

export async function proxyStableStream(req, res) {
    const ticket = String(getSingleValue(req.query?.ticket) || '').trim();
    if (!ticket) {
        throw createControlledError('INVALID_TICKET', 'Brakuje parametru ticket.', 400);
    }

    const session = getStreamSession(ticket);
    if (!session) {
        throw createControlledError('TICKET_EXPIRED', 'Ticket wygasl albo nie istnieje.', 410);
    }

    touchStreamSession(session);
    const assetId = String(getSingleValue(req.query?.asset) || 'root').trim() || 'root';
    const asset = assetId === 'root' ? (getRootAsset(session) || upsertStreamAsset(session, { id: 'root', kind: session.mediaType === 'hls' ? 'playlist' : 'file' })) : getStreamAsset(session, assetId);
    if (!asset) {
        throw createControlledError('ASSET_NOT_FOUND', 'Nie znaleziono zasobu streamu dla tego ticketu.', 404);
    }

    if (assetId === 'root' && session.mediaType === 'hls' || asset.kind === 'playlist') {
        const snapshot = await withSingleRefreshRetry(async (requestState) => {
            return loadPlaylistSnapshot(session, assetId === 'root' ? getRootAsset(session) || asset : asset, requestState);
        });
        const body = rewritePlaylistForClient(session, snapshot, req);

        res.status(200);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', snapshot.contentType || 'application/vnd.apple.mpegurl');
        res.setHeader('Content-Length', String(Buffer.byteLength(body)));
        res.send(body);
        return;
    }

    const upstream = await withSingleRefreshRetry(async (requestState) => {
        return fetchBinaryAsset(session, assetId === 'root' ? getRootAsset(session) || asset : asset, req, requestState);
    });

    setUpstreamResponseHeaders(res, upstream.response);
    res.status(upstream.response.status);
    await pipeline(upstream.stream, res);
}

export async function handleStreamFailure(res, error, debugEnabled = false) {
    const payload = toClientError(error, debugEnabled);
    setErrorHeaders(res);
    res.status(payload.status).json(payload.body);
}