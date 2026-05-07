// k6 entrypoint. Composes scenarios and shared thresholds.
//
// Usage:
//   k6 run perf/k6/main.js                                  (uses defaults)
//   k6 run --env BASE_URL=https://staging perf/k6/main.js
//   k6 run --env-file perf/k6/profiles/dev.env perf/k6/main.js  (preferred via Taskfile)

import browseEvents from './scenarios/browse_events.js';
import sitemapScenario from './scenarios/sitemap_seo.js';
import { DURATION, ENV, RAMP, VUS } from './lib/config.js';

// Sitemap gets ~15% of the headcount, capped to stay safely under 10/min IP limit.
const SITEMAP_VUS = Math.max(1, Math.round(VUS * 0.15));
const BROWSE_VUS = Math.max(1, VUS - SITEMAP_VUS);

export const options = {
    // Tag every request/metric with the target env for downstream filtering.
    tags: { env: ENV },
    // Higher-fidelity HTTP timings; small tradeoff in run-time CPU.
    discardResponseBodies: false,
    noConnectionReuse: false,
    scenarios: {
        browse_events: {
            executor: 'ramping-vus',
            exec: 'browse',
            startVUs: 0,
            stages: [
                { duration: RAMP, target: BROWSE_VUS },
                { duration: DURATION, target: BROWSE_VUS },
                { duration: '30s', target: 0 },
            ],
            gracefulRampDown: '15s',
            tags: { scenario: 'browse_events' },
        },
        sitemap_seo: {
            executor: 'constant-arrival-rate',
            exec: 'sitemap',
            // 6 requests / minute total — well under the 10/min per-IP limit.
            rate: 6,
            timeUnit: '1m',
            duration: DURATION,
            preAllocatedVUs: SITEMAP_VUS,
            maxVUs: SITEMAP_VUS,
            startTime: RAMP, // wait for browse ramp-up before crawling
            tags: { scenario: 'sitemap_seo' },
        },
    },
    thresholds: {
        // Pass/fail gates (CI-actionable):
        'http_req_failed{group:reads}': ['rate<0.01'],
        'http_req_duration{group:reads}': ['p(95)<500', 'p(99)<1000'],
        checks: ['rate>0.99'],
        errors: ['count<10'],
        // Per-route diagnostics (informational; no abort thresholds).
        'events_calendars_duration': ['p(95)<400'],
        'events_list_duration': ['p(95)<800'],
        'event_detail_duration': ['p(95)<400'],
        'attendance_summary_duration': ['p(95)<400'],
        'events_by_ids_duration': ['p(95)<600'],
        'sitemap_duration': ['p(95)<1500'],
    },
};

// k6 looks up scenario `exec` names as exported functions on this module.
export const browse = browseEvents;
export const sitemap = sitemapScenario;

export function setup() {
    return {
        env: ENV,
        vus: VUS,
        duration: DURATION,
        startedAt: new Date().toISOString(),
    };
}

export function handleSummary(data) {
    // Default text summary to stdout, plus machine-readable JSON + minimal HTML.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = `perf/results`;
    const jsonPath = `${dir}/summary-${ts}.json`;
    const htmlPath = `${dir}/summary-${ts}.html`;
    const latestJson = `${dir}/summary-latest.json`;
    const latestHtml = `${dir}/summary-latest.html`;
    const html = renderHtml(data);
    return {
        stdout: textSummary(data),
        [jsonPath]: JSON.stringify(data, null, 2),
        [latestJson]: JSON.stringify(data, null, 2),
        [htmlPath]: html,
        [latestHtml]: html,
    };
}

// --- minimal report renderers (no external dependencies) ---

function textSummary(data) {
    const lines = [];
    lines.push('');
    lines.push('═══ k6 perf summary ═══');
    lines.push(`env=${ENV}  vus=${VUS}  duration=${DURATION}`);
    lines.push('');
    const m = data.metrics || {};
    const fmt = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v));
    const interesting = [
        'http_reqs',
        'http_req_failed',
        'http_req_duration',
        'checks',
        'errors',
        'events_calendars_duration',
        'events_list_duration',
        'events_by_ids_duration',
        'event_detail_duration',
        'attendance_summary_duration',
        'sitemap_duration',
    ];
    for (const name of interesting) {
        const metric = m[name];
        if (!metric) continue;
        const v = metric.values || {};
        const parts = Object.entries(v)
            .map(([k, val]) => `${k}=${fmt(val)}`)
            .join(' ');
        lines.push(`  ${name.padEnd(32)} ${parts}`);
    }
    lines.push('');
    const tBreached = [];
    for (const [name, t] of Object.entries(data.thresholds || data.metrics || {})) {
        const thresh = (t && t.thresholds) || (m[name] && m[name].thresholds);
        if (!thresh) continue;
        for (const [k, info] of Object.entries(thresh)) {
            if (info && info.ok === false) tBreached.push(`${name}: ${k}`);
        }
    }
    if (tBreached.length) {
        lines.push('THRESHOLDS BREACHED:');
        tBreached.forEach((b) => lines.push('  ✗ ' + b));
    } else {
        lines.push('All thresholds passed.');
    }
    lines.push('');
    return lines.join('\n');
}

function renderHtml(data) {
    const m = data.metrics || {};
    const rows = Object.entries(m)
        .map(([name, metric]) => {
            const v = metric.values || {};
            const cells = Object.entries(v)
                .map(([k, val]) => `<span class="kv"><b>${k}</b>=${formatNum(val)}</span>`)
                .join(' ');
            const breaches = Object.entries(metric.thresholds || {})
                .filter(([_, info]) => info && info.ok === false)
                .map(([k]) => `<span class="bad">✗ ${escapeHtml(k)}</span>`)
                .join(' ');
            return `<tr><td><code>${escapeHtml(name)}</code></td><td>${cells}</td><td>${breaches}</td></tr>`;
        })
        .join('\n');
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>k6 perf summary</title>
<style>
body{font:14px/1.4 -apple-system,Segoe UI,sans-serif;margin:24px;color:#222}
table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #eee;padding:6px 8px;vertical-align:top;text-align:left}
.kv{margin-right:12px;white-space:nowrap}
.bad{color:#c00;font-weight:600}
code{background:#f4f4f4;padding:1px 4px;border-radius:3px}
</style></head>
<body>
<h1>k6 perf summary</h1>
<p>env=<b>${ENV}</b> vus=<b>${VUS}</b> duration=<b>${DURATION}</b></p>
<table><thead><tr><th>metric</th><th>values</th><th>thresholds</th></tr></thead><tbody>
${rows}
</tbody></table>
</body></html>`;
}

function formatNum(v) {
    if (typeof v !== 'number') return String(v);
    if (Number.isInteger(v)) return v.toString();
    return v.toFixed(2);
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
