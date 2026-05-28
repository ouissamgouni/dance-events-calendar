// Shared k6 config: env-driven base URL, default headers, common params.
// Env vars (set via -e KEY=value or --env-file *.env passed by Taskfile):
//   BASE_URL   required, e.g. http://localhost:8001
//   ENV        dev | staging | prod (informational, used in tags)
//   VUS        peak virtual users (default 15)
//   DURATION   sustain duration (default 5m)
//   RAMP       ramp-up duration (default 30s)
//   THINK_MIN  min think time seconds between steps (default 4)
//   THINK_MAX  max think time seconds between steps (default 10)
//   SUBSCRIPTIONS_ENABLED  true to include authenticated subscriptions journey
//   SUBSCRIPTION_USER_EMAIL mock dev-auth user for subscriptions journey
//
// All requests carry a synthetic-traffic marker so analytics can filter them out.

const _env = (typeof __ENV !== 'undefined') ? __ENV : {};

export const BASE_URL = (_env.BASE_URL || 'http://localhost:8001').replace(/\/+$/, '');
export const ENV = _env.ENV || 'dev';
export const VUS = parseInt(_env.VUS || '15', 10);
export const DURATION = _env.DURATION || '5m';
export const RAMP = _env.RAMP || '30s';
export const THINK_MIN = parseFloat(_env.THINK_MIN || '4');
export const THINK_MAX = parseFloat(_env.THINK_MAX || '10');
export const SUBSCRIPTIONS_ENABLED = (_env.SUBSCRIPTIONS_ENABLED || 'false') === 'true';
export const SUBSCRIPTION_USER_EMAIL = _env.SUBSCRIPTION_USER_EMAIL || 'viewer@example.com';

export const DEFAULT_HEADERS = {
    'User-Agent': 'salsa-perf-k6/1.0',
    'X-Synthetic-Traffic': '1',
    'Accept': 'application/json',
};

export function url(path) {
    if (!path.startsWith('/')) path = '/' + path;
    return `${BASE_URL}${path}`;
}

export function thinkSeconds() {
    return THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN);
}

export function pickN(arr, n) {
    if (!arr || arr.length === 0) return [];
    const copy = arr.slice();
    const out = [];
    const take = Math.min(n, copy.length);
    for (let i = 0; i < take; i++) {
        const idx = Math.floor(Math.random() * copy.length);
        out.push(copy.splice(idx, 1)[0]);
    }
    return out;
}
