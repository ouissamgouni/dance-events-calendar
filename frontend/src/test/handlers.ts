import { http, HttpResponse } from 'msw'
import type { AuthUser, PublicProfile } from '../api'

// All handlers use a wildcard origin (`*/api/...`) so they match whether
// `resolveApiBase()` returns the relative `/api` (resolved against the jsdom
// origin) or the absolute `http://localhost:8001/api` build define. Tests
// refine any of these per-case with `server.use(...)`.

/** A minimal authenticated user. Spread + override in tests as needed. */
export function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
    return {
        user_id: 'user-1',
        email: 'dancer@example.com',
        name: 'Test Dancer',
        is_admin: false,
        is_new_user: false,
        handle: 'testdancer',
        share_attendance_default_audience: 'friends',
        onboarded_at: '2025-01-01T00:00:00Z',
        needs_onboarding: false,
        timezone: 'UTC',
        email_event_reminders_enabled: true,
        email_social_activity_enabled: true,
        email_interest_matches_enabled: true,
        push_event_reminders_enabled: false,
        push_social_activity_enabled: false,
        push_interest_matches_enabled: false,
        // Legacy mirrors returned by the server for one release.
        reminder_email_enabled: true,
        activity_email_enabled: true,
        push_enabled: false,
        interest_notifications_enabled: true,
        ...overrides,
    }
}

/** A minimal public profile (a followable, public account). */
export function makeProfile(overrides: Partial<PublicProfile> = {}): PublicProfile {
    return {
        handle: 'testorg',
        display_name: 'Test Org',
        avatar_url: null,
        bio: null,
        member_since: '2025-01-01T00:00:00Z',
        is_verified_organizer: false,
        instagram_url: null,
        facebook_url: null,
        followers_count: 0,
        following_count: 0,
        subscribers_count: 0,
        going_count_30d: 0,
        is_self: false,
        is_following: false,
        follows_you: false,
        is_friend: false,
        follow_status: 'approved',
        account_visibility: 'public',
        show_in_suggestions: true,
        friend_count: 0,
        mutual_friend_count: 0,
        share_attendance_default_audience: 'friends',
        can_view_calendar: true,
        is_subscribed: false,
        notify_new_events: false,
        mutual_subscribers: [],
        mutual_subscribers_count: 0,
        ...overrides,
    }
}

export const handlers = [
    // ── Auth ───────────────────────────────────────────────────────────────
    // Default: anonymous. Auth tests override with a 200 + user body.
    http.get('*/api/auth/me', () => HttpResponse.json(null, { status: 401 })),
    http.post('*/api/auth/google', () => HttpResponse.json(makeUser())),
    http.post('*/api/auth/logout', () => new HttpResponse(null, { status: 204 })),
    http.delete('*/api/auth/me', () => new HttpResponse(null, { status: 204 })),

    // ── Notification preferences ────────────────────────────────────────────
    // Echoes the patched fields back over the server defaults. Tests that need
    // to assert the request body refine this with `server.use(...)`.
    http.patch('*/api/auth/notification-preferences', async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
        return HttpResponse.json({
            timezone: 'UTC',
            email_event_reminders_enabled: true,
            email_social_activity_enabled: true,
            email_interest_matches_enabled: true,
            push_event_reminders_enabled: false,
            push_social_activity_enabled: false,
            push_interest_matches_enabled: false,
            reminder_email_enabled: true,
            activity_email_enabled: true,
            push_enabled: false,
            interest_notifications_enabled: true,
            ...body,
        })
    }),

    // ── Web-push ────────────────────────────────────────────────────────────
    // Default: web-push disabled (no VAPID key) so usePush settles on
    // 'disabled'. Push tests override with a 200 + { public_key }.
    http.get('*/api/push/vapid-public-key', () => HttpResponse.json(null, { status: 404 })),
    http.post('*/api/push/subscribe', () => new HttpResponse(null, { status: 204 })),
    http.post('*/api/push/unsubscribe', () => new HttpResponse(null, { status: 204 })),

    // ── Saved / attending lists (provider mount reconciliation) ─────────────
    http.get('*/api/auth/saved-events', () => HttpResponse.json({ events: [] })),
    http.get('*/api/auth/attending-events', () => HttpResponse.json({ events: [] })),

    // ── Attendance summary batch (AttendanceSummariesProvider) ──────────────
    http.post('*/api/events/attendance-summary', () => HttpResponse.json({ summaries: [] })),

    // ── Functional writes (RSVP / save) ─────────────────────────────────────
    http.post('*/api/track/event-attendance', () => new HttpResponse(null, { status: 204 })),
    http.post('*/api/track/event-save', () => new HttpResponse(null, { status: 204 })),

    // ── Social (follow / unfollow) ──────────────────────────────────────────
    http.get('*/api/social/users/:handle', ({ params }) =>
        HttpResponse.json(makeProfile({ handle: String(params.handle) })),
    ),
    http.post('*/api/social/users/:handle/follow', ({ params }) =>
        HttpResponse.json({
            handle: params.handle,
            is_following: true,
            is_friend: false,
            followers_count: 1,
            is_subscribed: true,
            notify_new_events: true,
            follow_status: 'approved',
        }),
    ),
    http.delete('*/api/social/users/:handle/follow', ({ params }) =>
        HttpResponse.json({
            handle: params.handle,
            is_following: false,
            is_friend: false,
            followers_count: 0,
            is_subscribed: false,
            notify_new_events: false,
            follow_status: 'approved',
        }),
    ),

    // Profile tab data (lazy-loaded once a profile renders).
    http.get('*/api/social/users/:handle/calendar', () =>
        HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 }),
    ),
    http.get('*/api/social/users/:handle/:tab', () =>
        HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 }),
    ),

    // ── Events discovery ────────────────────────────────────────────────────
    http.get('*/api/events', () => HttpResponse.json({ events: [], total: 0 })),

    // ── Tags (suggestion modal mount) ───────────────────────────────────────
    http.get('*/api/tags', () => HttpResponse.json([])),

    // ── Event suggestion submission ─────────────────────────────────────────
    http.post('*/api/suggestions', () =>
        HttpResponse.json({ id: 'sugg-1', message: 'Thanks! Your event is under review.' }),
    ),
]
