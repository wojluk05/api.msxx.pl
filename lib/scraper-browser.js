import { createRequire } from 'module';
import { detectCloudflareChallenge, waitForCloudflareBypass } from './scraper-cloudflare.js';

const require = createRequire(import.meta.url);

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

let stealthPluginApplied = false;
let persistentBrowser = null;
let persistentBrowserLaunching = null;

async function ensurePersistentBrowser() {
    if (persistentBrowser) {
        try {
            await persistentBrowser.pages();
            return persistentBrowser;
        } catch {
            persistentBrowser = null;
            persistentBrowserLaunching = null;
        }
    }

    if (persistentBrowserLaunching) {
        return persistentBrowserLaunching;
    }

    const puppeteerExtra = require('puppeteer-extra');
    const stealthPlugin = require('puppeteer-extra-plugin-stealth');
    const puppeteer = require('puppeteer');

    if (!stealthPluginApplied) {
        puppeteerExtra.use(stealthPlugin());
        stealthPluginApplied = true;
    }

    persistentBrowserLaunching = puppeteerExtra.launch({
        headless: parseBoolean(process.env.BROWSER_HEADLESS, true),
        timeout: 35000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-features=IsolateOrigins,site-per-process'
        ],
        executablePath: process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath()
    }).then((browser) => {
        browser.on('disconnected', () => {
            persistentBrowser = null;
            persistentBrowserLaunching = null;
        });
        persistentBrowser = browser;
        persistentBrowserLaunching = null;
        return browser;
    }).catch((err) => {
        persistentBrowserLaunching = null;
        throw err;
    });

    return persistentBrowserLaunching;
}

async function warmUp() {
    try {
        await ensurePersistentBrowser();
    } catch (_) {}
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

function toPositiveInt(value, fallbackValue, minValue = 1) {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isInteger(parsed) || parsed < minValue) {
        return fallbackValue;
    }

    return parsed;
}

function createSessionStore(ttlMs) {
    const store = new Map();

    function get(sessionKey) {
        const key = String(sessionKey || '').trim();
        if (!key) {
            return [];
        }

        const entry = store.get(key);
        if (!entry) {
            return [];
        }

        if (entry.expiresAt <= Date.now()) {
            store.delete(key);
            return [];
        }

        return Array.isArray(entry.cookies) ? entry.cookies : [];
    }

    function set(sessionKey, cookies) {
        const key = String(sessionKey || '').trim();
        if (!key || !Array.isArray(cookies) || cookies.length === 0) {
            return;
        }

        store.set(key, {
            cookies,
            expiresAt: Date.now() + ttlMs
        });
    }

    function count() {
        const now = Date.now();
        for (const [key, entry] of store.entries()) {
            if (!entry || entry.expiresAt <= now) {
                store.delete(key);
            }
        }

        return store.size;
    }

    return { get, set, count };
}

export function createBrowserService(config = {}) {
    const sessionStore = createSessionStore(toPositiveInt(config.sessionTtlMs, 15 * 60 * 1000, 1000));
    const launchTimeoutMs = toPositiveInt(config.browserTimeoutMs, 35000, 5000);
    const headless = parseBoolean(config.headless, true);
    const blockResources = parseBoolean(config.blockResources, true);
    const maxChallengeWaitMs = toPositiveInt(config.cfMaxWaitMs, 28000, 3000);
    const challengeRetries = toPositiveInt(config.cfClickRetries, 8, 1);
    const userAgent = String(config.userAgent || DEFAULT_USER_AGENT);

    const proxyServer = String(config.proxyServer || '').trim();
    const proxyUsername = String(config.proxyUsername || '').trim();
    const proxyPassword = String(config.proxyPassword || '').trim();

    const chromePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

    function createBaseLaunchArgs() {
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-features=IsolateOrigins,site-per-process'
        ];

        if (proxyServer) {
            args.push(`--proxy-server=${proxyServer}`);
        }

        return args;
    }

    async function preparePage(page, requestUrl, options = {}) {
        await page.setUserAgent(userAgent);
        await page.setViewport({ width: 1440, height: 900 });
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
            Referer: options.referer || requestUrl
        });

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        if (proxyUsername && proxyPassword) {
            await page.authenticate({ username: proxyUsername, password: proxyPassword }).catch(() => null);
        }

        if (blockResources && options.render !== false) {
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                const type = request.resourceType();
                if (['image', 'font'].includes(type)) {
                    request.abort().catch(() => null);
                    return;
                }

                request.continue().catch(() => null);
            });
        }
    }

    async function runHttpOnly(targetUrl, options) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), toPositiveInt(options.timeoutMs, 10000, 1000));

        try {
            const response = await fetch(targetUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': userAgent,
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7'
                },
                redirect: 'follow',
                signal: controller.signal
            });

            const html = await response.text();
            const blocked = detectCloudflareChallenge(html, response.url || targetUrl);

            return {
                ok: response.ok,
                blocked,
                strategy: 'http',
                html,
                finalUrl: response.url || targetUrl,
                status: response.status,
                headers: Object.fromEntries(response.headers.entries())
            };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async function applySessionCookies(page, targetUrl, sessionKey) {
        const cachedCookies = sessionStore.get(sessionKey);
        if (!cachedCookies.length) {
            return 0;
        }

        const targetHost = new URL(targetUrl).hostname;
        const filtered = cachedCookies.filter((cookie) => {
            const domain = String(cookie.domain || '').replace(/^\./, '');
            if (!domain) {
                return true;
            }

            return targetHost === domain || targetHost.endsWith(`.${domain}`);
        });

        if (!filtered.length) {
            return 0;
        }

        await page.setCookie(...filtered).catch(() => null);
        return filtered.length;
    }

    async function persistSessionCookies(page, sessionKey) {
        const key = String(sessionKey || '').trim();
        if (!key) {
            return 0;
        }

        const cookies = await page.cookies().catch(() => []);
        if (!Array.isArray(cookies) || cookies.length === 0) {
            return 0;
        }

        sessionStore.set(key, cookies);
        return cookies.length;
    }

    async function runWithRealBrowser(targetUrl, options = {}) {
        const { connect } = require('puppeteer-real-browser');

        let browser;
        let page;

        try {
            const result = await connect({
                headless,
                turnstile: true,
                args: createBaseLaunchArgs(),
                customConfig: {
                    executablePath: chromePath
                }
            });

            browser = result.browser;
            page = result.page;

            if (!page) {
                page = await browser.newPage();
            }

            await preparePage(page, targetUrl, options);
            const reusedCookies = await applySessionCookies(page, targetUrl, options.sessionKey);

            const response = await page.goto(targetUrl, {
                waitUntil: 'domcontentloaded',
                timeout: toPositiveInt(options.timeoutMs, launchTimeoutMs, 5000)
            });

            if (options.waitForSelector) {
                await page.waitForSelector(options.waitForSelector, {
                    timeout: toPositiveInt(options.selectorTimeoutMs, 12000, 500)
                }).catch(() => null);
            }

            const firstHtml = await page.content().catch(() => '');
            const challenge = detectCloudflareChallenge(firstHtml, page.url());
            let challengeResult = { solved: !challenge, blocked: challenge, attempts: 0, elapsedMs: 0 };

            if (challenge) {
                challengeResult = await waitForCloudflareBypass(page, {
                    maxWaitMs: maxChallengeWaitMs,
                    clickRetries: challengeRetries
                });
            }

            const html = await page.content().catch(() => firstHtml);
            const blocked = detectCloudflareChallenge(html, page.url());
            const storedCookies = await persistSessionCookies(page, options.sessionKey);

            return {
                ok: !blocked,
                blocked,
                strategy: 'real-browser',
                html,
                finalUrl: page.url(),
                status: response ? response.status() : 200,
                headers: response ? response.headers() : {},
                reusedCookies,
                storedCookies,
                challenge: challengeResult
            };
        } finally {
            if (browser) {
                await browser.close().catch(() => null);
            }
        }
    }

    async function runWithStealth(targetUrl, options = {}) {
        const browser = await ensurePersistentBrowser();
        const page = await browser.newPage();

        try {
            await preparePage(page, targetUrl, options);
            const reusedCookies = await applySessionCookies(page, targetUrl, options.sessionKey);

            const response = await page.goto(targetUrl, {
                waitUntil: 'domcontentloaded',
                timeout: toPositiveInt(options.timeoutMs, launchTimeoutMs, 5000)
            });

            if (options.waitForSelector) {
                await page.waitForSelector(options.waitForSelector, {
                    timeout: toPositiveInt(options.selectorTimeoutMs, 12000, 500)
                }).catch(() => null);
            }

            const firstHtml = await page.content().catch(() => '');
            const challenge = detectCloudflareChallenge(firstHtml, page.url());
            let challengeResult = { solved: !challenge, blocked: challenge, attempts: 0, elapsedMs: 0 };

            if (challenge) {
                challengeResult = await waitForCloudflareBypass(page, {
                    maxWaitMs: maxChallengeWaitMs,
                    clickRetries: challengeRetries
                });
            }

            const html = await page.content().catch(() => firstHtml);
            const blocked = detectCloudflareChallenge(html, page.url());
            const storedCookies = await persistSessionCookies(page, options.sessionKey);

            return {
                ok: !blocked,
                blocked,
                strategy: 'stealth',
                html,
                finalUrl: page.url(),
                status: response ? response.status() : 200,
                headers: response ? response.headers() : {},
                reusedCookies,
                storedCookies,
                challenge: challengeResult
            };
        } finally {
            await page.close().catch(() => null);
        }
    }

    async function fetchHtml(targetUrl, options = {}) {
        const startedAt = Date.now();
        const render = parseBoolean(options.render, true);
        const timeoutMs = toPositiveInt(options.timeoutMs, launchTimeoutMs, 5000);
        const sessionKey = String(options.sessionKey || '').trim();

        const trace = [];
        const errors = [];
        let lastStrategyResult = null;

        if (!render) {
            try {
                const httpResult = await runHttpOnly(targetUrl, { timeoutMs });

                trace.push({
                    strategy: 'http',
                    blocked: httpResult.blocked,
                    status: httpResult.status,
                    finalUrl: httpResult.finalUrl
                });

                if (httpResult.ok && !httpResult.blocked) {
                    return { ...httpResult, elapsedMs: Date.now() - startedAt, trace, errors };
                }
            } catch (error) {
                errors.push(`http:${error.message || String(error)}`);
            }
        }

        const hasCachedCookies = sessionKey && sessionStore.get(sessionKey).length > 0;

        const browserStrategies = hasCachedCookies
            ? [
                { name: 'stealth', run: runWithStealth },
                { name: 'real-browser', run: runWithRealBrowser }
              ]
            : [
                { name: 'real-browser', run: runWithRealBrowser },
                { name: 'stealth', run: runWithStealth }
              ];

        for (const strategy of browserStrategies) {
            try {
                const strategyResult = await strategy.run(targetUrl, { ...options, render, timeoutMs, sessionKey });

                lastStrategyResult = strategyResult;

                trace.push({
                    strategy: strategy.name,
                    blocked: strategyResult.blocked,
                    status: strategyResult.status,
                    finalUrl: strategyResult.finalUrl,
                    challenge: strategyResult.challenge || null
                });

                if (strategyResult.ok && !strategyResult.blocked) {
                    return { ...strategyResult, elapsedMs: Date.now() - startedAt, trace, errors };
                }

                errors.push(`${strategy.name}:challenge_not_solved`);
            } catch (error) {
                errors.push(`${strategy.name}:${error.message || String(error)}`);
            }
        }

        const allChallengeFailures = errors.length > 0 && errors.every((e) => e.includes('challenge_not_solved'));
        const messageSuffix = allChallengeFailures
            ? ' (Cloudflare challenge not solved; consider configuring a proxy)'
            : '';

        const failureError = new Error(`All strategies failed: ${errors.join(' | ') || 'unknown error'}${messageSuffix}`);
        failureError.code = 'ALL_STRATEGIES_FAILED';
        failureError.details = { trace, errors, elapsedMs: Date.now() - startedAt, lastStrategyResult };

        throw failureError;
    }

    return { fetchHtml, sessionStore, warmUp };
}
