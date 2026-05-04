import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const cheerio = require('cheerio');

function normalizeAbsoluteUrl(value, baseUrl) {
    try {
        const url = new URL(String(value || '').trim(), String(baseUrl || '').trim());
        if (!/^https?:$/i.test(url.protocol)) {
            return '';
        }

        return url.toString();
    } catch {
        return '';
    }
}

function decodeDataIframe(rawValue) {
    try {
        const decoded = Buffer.from(String(rawValue || ''), 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        const sourceUrl = parsed && parsed.src ? String(parsed.src).trim() : '';
        if (!sourceUrl) {
            return '';
        }

        return sourceUrl.startsWith('//') ? `https:${sourceUrl}` : sourceUrl;
    } catch {
        return '';
    }
}

function extractDataIframeValues(html) {
    const values = [];
    const regex = /data-iframe\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
    let match;

    while ((match = regex.exec(String(html || '')))) {
        const value = match[1] || match[2] || '';
        if (value) {
            values.push(value);
        }
    }

    return values;
}

export function extractSourcesFromHtml(html) {
    const rawValues = extractDataIframeValues(html);
    const decoded = rawValues
        .map((item) => decodeDataIframe(item))
        .filter(Boolean);

    return Array.from(new Set(decoded));
}

export function extractSearchResults(html, baseUrl) {
    const $ = cheerio.load(String(html || ''));
    const results = [];
    const seen = new Set();

    $('a.clearfix.item, article a[href], .result-item a[href], .item a[href], .posts .post a[href]').each((_index, element) => {
        const node = $(element);
        const href = normalizeAbsoluteUrl(node.attr('href') || '', baseUrl);
        if (!href || seen.has(href)) {
            return;
        }

        const title = node.find('.title, h1, h2, h3').first().text().trim() || node.attr('title') || node.text().trim();
        const textBlob = node.text().replace(/\s+/g, ' ').trim();
        const yearMatch = textBlob.match(/(19|20)\d{2}/);

        seen.add(href);
        results.push({
            title,
            url: href,
            meta: textBlob,
            year: yearMatch ? yearMatch[0] : ''
        });
    });

    return results.slice(0, 40);
}
