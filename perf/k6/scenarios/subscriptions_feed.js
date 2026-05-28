// Authenticated My Calendar subscriptions journey.
// Mirrors /my-calendar/subscriptions today: login, list followed calendars,
// load Everyone, load one scoped user feed, then hydrate returned event ids.
import http from 'k6/http';
import { sleep } from 'k6';

import {
    DEFAULT_HEADERS,
    SUBSCRIPTION_USER_EMAIL,
    pickN,
    thinkSeconds,
    url,
} from '../lib/config.js';
import { checkOk, trends } from '../lib/checks.js';

const params = { headers: DEFAULT_HEADERS };
const jsonParams = {
    headers: { ...DEFAULT_HEADERS, 'Content-Type': 'application/json' },
};

function hydrateSubscriptionItems(items, routeTag) {
    const ids = pickN(
        (items || []).map((item) => item.event_id).filter(Boolean),
        Math.min(10, (items || []).length)
    );
    if (ids.length === 0) return;
    const byIdsRes = http.post(
        url('/api/events/by-ids'),
        JSON.stringify({ event_ids: ids }),
        { ...jsonParams, tags: { route: routeTag, group: 'reads' } }
    );
    checkOk(byIdsRes, 'POST /api/events/by-ids subscriptions', trends.subscriptionsByIds);
}

export default function subscriptionsFeed() {
    const deviceId = `k6-subscriptions-${__VU}`;
    const loginRes = http.post(
        url('/api/auth/google'),
        JSON.stringify({
            credential: 'ignored',
            mock_email: SUBSCRIPTION_USER_EMAIL,
            device_id: deviceId,
        }),
        { ...jsonParams, tags: { route: 'auth_login', group: 'reads' } }
    );
    const loggedIn = checkOk(loginRes, 'POST /api/auth/google dev login', trends.authLogin);
    if (!loggedIn) return;
    sleep(thinkSeconds());

    const subsRes = http.get(url('/api/social/me/subscriptions?limit=50'), {
        ...params,
        tags: { route: 'subscriptions_list', group: 'reads' },
    });
    const subsOk = checkOk(subsRes, 'GET /api/social/me/subscriptions', trends.subscriptionsList);
    let subscriptions = [];
    if (subsOk) {
        try {
            subscriptions = subsRes.json('items') || [];
            if (!Array.isArray(subscriptions)) subscriptions = [];
        } catch (_e) {
            subscriptions = [];
        }
    }
    sleep(thinkSeconds());

    const everyoneRes = http.get(url('/api/social/me/subscribed-events?limit=100'), {
        ...params,
        tags: { route: 'subscribed_events_everyone', group: 'reads' },
    });
    const everyoneOk = checkOk(everyoneRes, 'GET /api/social/me/subscribed-events everyone', trends.subscribedEventsEveryone);
    let everyoneItems = [];
    if (everyoneOk) {
        try {
            everyoneItems = everyoneRes.json('items') || [];
            if (!Array.isArray(everyoneItems)) everyoneItems = [];
        } catch (_e) {
            everyoneItems = [];
        }
    }
    hydrateSubscriptionItems(everyoneItems, 'subscribed_events_by_ids_everyone');
    sleep(thinkSeconds());

    const visibleHandles = subscriptions
        .filter((item) => item && item.handle && item.can_view_calendar !== false)
        .map((item) => item.handle);
    if (visibleHandles.length === 0) return;

    const handle = visibleHandles[Math.floor(Math.random() * visibleHandles.length)];
    const scopedRes = http.get(
        url(`/api/social/me/subscribed-events?from_handle=${encodeURIComponent(handle)}&limit=100`),
        { ...params, tags: { route: 'subscribed_events_scoped', group: 'reads' } }
    );
    const scopedOk = checkOk(scopedRes, 'GET /api/social/me/subscribed-events scoped', trends.subscribedEventsScoped);
    let scopedItems = [];
    if (scopedOk) {
        try {
            scopedItems = scopedRes.json('items') || [];
            if (!Array.isArray(scopedItems)) scopedItems = [];
        } catch (_e) {
            scopedItems = [];
        }
    }
    hydrateSubscriptionItems(scopedItems, 'subscribed_events_by_ids_scoped');
    sleep(thinkSeconds());
}
