// Low-frequency SEO crawler simulation. The sitemap endpoint is rate-limited
// to 10/min per IP, so this scenario uses constant-arrival-rate at well below
// that ceiling.
import http from 'k6/http';

import { DEFAULT_HEADERS, url } from '../lib/config.js';
import { checkOk, trends } from '../lib/checks.js';

const params = {
    headers: { ...DEFAULT_HEADERS, Accept: 'application/xml' },
    tags: { route: 'sitemap', group: 'reads' },
};

export default function sitemap() {
    const res = http.get(url('/api/events/seo/sitemap.xml'), params);
    checkOk(res, 'GET /api/events/seo/sitemap.xml', trends.sitemap);
}
