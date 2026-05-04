const CF_STRONG_PATTERNS = [
    /attention required/i,
    /just a moment/i,
    /checking your browser/i,
    /challenge-platform/i,
    /cf-browser-verification/i,
    /cf-chl/i,
    /verify you are human/i,
    /challenges\.cloudflare\.com/i,
    /cf-turnstile-response/i,
    /cf challenge/i
];

const CF_WEAK_PATTERNS = [
    /turnstile/i,
    /ray id/i,
    /cloudflare/i
];

const CHALLENGE_SELECTORS = [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="turnstile"]',
    'input[type="checkbox"][name*="cf"]',
    'input[type="checkbox"]',
    '[name="cf-turnstile-response"]'
];

function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, Number(ms) || 0);
    });
}

function extractTitle(html) {
    const source = String(html || '');
    const match = source.match(/<title[^>]*>([\s\S]{0,200})<\/title>/i);
    if (!match) {
        return '';
    }

    return String(match[1] || '').trim().toLowerCase();
}

async function waitOnPage(page, ms) {
    const timeoutMs = Number(ms) || 0;

    if (page && typeof page.waitForTimeout === 'function') {
        await page.waitForTimeout(timeoutMs).catch(() => null);
        return;
    }

    if (page && typeof page.waitFor === 'function') {
        await page.waitFor(timeoutMs).catch(() => null);
        return;
    }

    await delay(timeoutMs);
}

export function detectCloudflareChallenge(html, currentUrl) {
    const htmlSource = String(html || '');
    const source = `${String(currentUrl || '')}\n${htmlSource}`;

    if (CF_STRONG_PATTERNS.some((pattern) => pattern.test(source))) {
        return true;
    }

    const weakMatches = CF_WEAK_PATTERNS.reduce((count, pattern) => {
        return count + (pattern.test(source) ? 1 : 0);
    }, 0);

    if (weakMatches >= 2) {
        return true;
    }

    const title = extractTitle(htmlSource);
    if (title.includes('just a moment') || title.includes('attention required')) {
        return true;
    }

    return false;
}

async function clickTurnstileFrames(page) {
    const selectors = [
        'iframe[src*="challenges.cloudflare.com"]',
        'iframe[src*="turnstile"]'
    ];

    let clicked = false;

    for (const selector of selectors) {
        const handles = await page.$$(selector).catch(() => []);
        for (const handle of handles) {
            try {
                const box = await handle.boundingBox().catch(() => null);
                if (box && page.mouse && typeof page.mouse.click === 'function') {
                    const x = Math.round(box.x + (box.width / 2));
                    const y = Math.round(box.y + (box.height / 2));
                    await page.mouse.move(x, y).catch(() => null);
                    await delay(60);
                    await page.mouse.click(x, y, { delay: 40 }).catch(() => null);
                    clicked = true;
                }
            } finally {
                await handle.dispose().catch(() => null);
            }
        }
    }

    return clicked;
}

async function clickChallengeCandidates(page) {
    let clicked = false;

    for (const selector of CHALLENGE_SELECTORS) {
        const handle = await page.$(selector).catch(() => null);
        if (!handle) {
            continue;
        }

        try {
            await handle.click({ delay: 30 }).catch(() => null);
            clicked = true;
        } finally {
            await handle.dispose().catch(() => null);
        }
    }

    const iframeClicked = await clickTurnstileFrames(page).catch(() => false);
    if (iframeClicked) {
        clicked = true;
    }

    const frames = page.frames();
    for (const frame of frames) {
        const frameUrl = String(frame.url() || '').toLowerCase();
        if (!frameUrl.includes('challenge') && !frameUrl.includes('turnstile') && !frameUrl.includes('cloudflare')) {
            continue;
        }

        const frameCheckbox = await frame.$('input[type="checkbox"]').catch(() => null);
        if (frameCheckbox) {
            try {
                await frameCheckbox.click({ delay: 30 }).catch(() => null);
                clicked = true;
            } finally {
                await frameCheckbox.dispose().catch(() => null);
            }
        }
    }

    return clicked;
}

export async function waitForCloudflareBypass(page, options = {}) {
    const maxWaitMs = Number(options.maxWaitMs) || 14000;
    const clickRetries = Number(options.clickRetries) || 4;
    const startedAt = Date.now();

    const stepDelayMs = Math.min(2400, Math.max(1100, Math.floor(maxWaitMs / (clickRetries + 2))));

    for (let attempt = 1; attempt <= clickRetries; attempt += 1) {
        const html = await page.content().catch(() => '');
        const blocked = detectCloudflareChallenge(html, page.url());
        if (!blocked) {
            return {
                solved: true,
                blocked: false,
                attempts: attempt,
                elapsedMs: Date.now() - startedAt
            };
        }

        await clickChallengeCandidates(page).catch(() => null);
        await Promise.race([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: stepDelayMs }).catch(() => null),
            waitOnPage(page, stepDelayMs)
        ]);

        if (page.keyboard && typeof page.keyboard.press === 'function') {
            await page.keyboard.press('Tab').catch(() => null);
            await page.keyboard.press('Space').catch(() => null);
        }

        if ((Date.now() - startedAt) >= maxWaitMs) {
            break;
        }
    }

    const html = await page.content().catch(() => '');
    const blocked = detectCloudflareChallenge(html, page.url());

    return {
        solved: !blocked,
        blocked,
        attempts: clickRetries,
        elapsedMs: Date.now() - startedAt
    };
}
