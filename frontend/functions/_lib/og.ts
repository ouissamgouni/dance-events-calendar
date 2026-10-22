/** Shared helpers for the link-preview Pages Functions (no route of its own). */

export interface OgEnv {
    API_BASE?: string;
    PUBLIC_BASE?: string;
    OG_FALLBACK_IMAGE?: string;
}

const BOT_UA_FRAGMENTS = [
    'facebookexternalhit',
    'facebot',
    'twitterbot',
    'linkedinbot',
    'slackbot',
    'slack-imgproxy',
    'whatsapp',
    'telegrambot',
    'discordbot',
    'pinterest',
    'redditbot',
    'embedly',
    'quora link preview',
    'showyoubot',
    'outbrain',
    'vkshare',
    'w3c_validator',
    'bingbot',
    'googlebot',
    'applebot',
    'duckduckbot',
];

export function isBot(userAgent: string | null): boolean {
    if (!userAgent) return false;
    const ua = userAgent.toLowerCase();
    return BOT_UA_FRAGMENTS.some((frag) => ua.includes(frag));
}

export function htmlEscape(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function publicBaseFor(request: Request, env: OgEnv): string {
    const url = new URL(request.url);
    return env.PUBLIC_BASE ?? `${url.protocol}//${url.host}`;
}

export function fallbackImage(publicBase: string, env: OgEnv): string {
    return env.OG_FALLBACK_IMAGE ?? `${publicBase}/og-card.jpg`;
}

export async function fetchJson<T>(url: string): Promise<T | null> {
    // 3s ceiling — chat-app crawlers typically time out around 5s.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
        const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
        return res.ok ? ((await res.json()) as T) : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

export function renderCard(card: { title: string; description: string; url: string; image: string }): Response {
    const title = htmlEscape(card.title);
    const description = htmlEscape(card.description);
    const url = htmlEscape(card.url);
    const image = htmlEscape(card.image);
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:site_name" content="Movida">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${image}">
</head>
<body>
<h1>${title}</h1>
<p>${description}</p>
<p><a href="${url}">Open on Movida</a></p>
</body>
</html>`;
    return new Response(html, {
        status: 200,
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'public, max-age=300, s-maxage=3600',
            'x-prerendered': 'movida-pages-function',
        },
    });
}
