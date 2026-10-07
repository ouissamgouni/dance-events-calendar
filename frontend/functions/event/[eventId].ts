/**
 * Cloudflare Pages Function — pre-renders Open Graph + JSON-LD tags for
 * link-preview crawlers (WhatsApp, iMessage, Slack, Twitter, LinkedIn,
 * Facebook, Telegram, Discord) hitting `/event/:eventId`.
 *
 * Why this exists:
 * The frontend is a Vite SPA, so the index.html shell delivered to all
 * visitors contains no event-specific meta tags. Real crawlers do not
 * execute JavaScript, so client-side <Helmet> tags are invisible to them
 * and shared links render as bare URLs. This function intercepts known
 * crawler user-agents at the edge and returns hand-rolled HTML with the
 * correct og:* / twitter:* / Event JSON-LD. Human visitors are passed
 * through untouched to the SPA.
 *
 * Configuration:
 *   API_BASE — set in Pages → Settings → Environment variables, e.g.
 *              `https://api.joinmovida.com` (production) or
 *              `https://api-develop.joinmovida.com` (staging).
 *   PUBLIC_BASE — public origin used to build absolute URLs in the
 *                 rendered HTML, e.g. `https://joinmovida.com`. Falls
 *                 back to the request origin when unset.
 *   OG_FALLBACK_IMAGE — full URL to the branded 1200×630 fallback image
 *                       used when an event has no specific image. Defaults
 *                       to `${PUBLIC_BASE}/og-card.jpg` (`frontend/public/og-card.jpg`,
 *                       a compressed copy of og-fallback.png — chat apps skip
 *                       preview images much over ~300 KB).
 */

import { htmlEscape, isBot, type OgEnv as Env } from '../_lib/og';

interface OgMeta {
    event_id: string;
    title: string;
    description: string | null;
    location: string | null;
    start: string | null;
    end: string | null;
    latitude: number | null;
    longitude: number | null;
    price_is_free: boolean;
    price_min: number | null;
    price_currency: string | null;
    image_url?: string | null;
}

function renderHtml(meta: OgMeta, canonicalUrl: string, ogImage: string, isFallbackImage: boolean): string {
    const title = htmlEscape(meta.title);
    const description = meta.description
        ? htmlEscape(meta.description)
        : 'Find salsa events near you on Movida.';
    const safeUrl = htmlEscape(canonicalUrl);
    const safeImage = htmlEscape(ogImage);

    // Schema.org Event JSON-LD — picked up by Google for the events
    // knowledge panel and by some chat apps for richer cards.
    const jsonLd: Record<string, unknown> = {
        '@context': 'https://schema.org',
        '@type': 'Event',
        name: meta.title,
        description: meta.description ?? undefined,
        startDate: meta.start ?? undefined,
        endDate: meta.end ?? undefined,
        url: canonicalUrl,
        image: ogImage,
        eventStatus: 'https://schema.org/EventScheduled',
        eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    };
    if (meta.location) {
        jsonLd.location = {
            '@type': 'Place',
            name: meta.location,
            address: meta.location,
        };
    }
    if (meta.price_is_free || meta.price_min != null) {
        jsonLd.offers = {
            '@type': 'Offer',
            price: meta.price_is_free ? 0 : meta.price_min,
            priceCurrency: meta.price_currency ?? 'EUR',
            availability: 'https://schema.org/InStock',
            url: canonicalUrl,
        };
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Movida</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${safeUrl}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${safeUrl}">
<meta property="og:image" content="${safeImage}">
${isFallbackImage ? '<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">' : ''}
<meta property="og:site_name" content="Movida">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${safeImage}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<h1>${title}</h1>
<p>${description}</p>
<p><a href="${safeUrl}">Open on Movida</a></p>
</body>
</html>`;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const { request, env, params, next } = context;
    const userAgent = request.headers.get('user-agent');

    // Humans get the SPA shell exactly as before — no behaviour change.
    if (!isBot(userAgent)) {
        return next();
    }

    const eventId = params.eventId;
    if (typeof eventId !== 'string' || !eventId) {
        return next();
    }

    const apiBase = env.API_BASE;
    if (!apiBase) {
        // Misconfiguration: fall through to the SPA so the link still
        // resolves for humans even if previews are degraded.
        return next();
    }

    const url = new URL(request.url);
    const publicBase = env.PUBLIC_BASE ?? `${url.protocol}//${url.host}`;
    const canonicalUrl = `${publicBase}/event/${encodeURIComponent(eventId)}`;
    const fallbackImage =
        env.OG_FALLBACK_IMAGE ?? `${publicBase}/og-card.jpg`;

    let meta: OgMeta | null = null;
    try {
        const apiUrl = `${apiBase}/api/events/${encodeURIComponent(eventId)}/og-meta`;
        // 3s ceiling — chat-app crawlers typically time out around 5s.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(apiUrl, {
            headers: { accept: 'application/json' },
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
            meta = (await res.json()) as OgMeta;
        }
    } catch {
        // Network error / timeout / abort — fall through to a generic card.
    }

    if (!meta) {
        // 404 from API or upstream failure: still return *something* with
        // brand metadata so the link doesn't render as a bare URL.
        meta = {
            event_id: eventId,
            title: 'Movida',
            description: 'Find salsa events near you.',
            location: null,
            start: null,
            end: null,
            latitude: null,
            longitude: null,
            price_is_free: false,
            price_min: null,
            price_currency: null,
        };
    }

    // Crawlers need an absolute https URL; anything else falls back to the brand card.
    const eventImage = meta.image_url?.startsWith('https://') ? meta.image_url : null;
    const html = renderHtml(meta, canonicalUrl, eventImage ?? fallbackImage, !eventImage);
    return new Response(html, {
        status: 200,
        headers: {
            'content-type': 'text/html; charset=utf-8',
            // Edge cache for 1h, browser/crawler cache for 5min — crawlers
            // hammer popular links repeatedly so this matters for cost.
            'cache-control': 'public, max-age=300, s-maxage=3600',
            // Hint to crawlers that we recognised them.
            'x-prerendered': 'movida-pages-function',
        },
    });
};
