import { useEffect, useState } from 'react';
import { fetchAdminEventNotificationStats } from '../api';
import type { AdminEventNotificationStats, CalendarEvent } from '../types';

const KIND_LABELS: Record<string, string> = {
    interest_event: 'Saved-search match',
    subscription_going: 'Friend going',
    subscription_saved: 'Friend saved',
    subscription_suggested: 'Suggested',
    subscription_review: 'Friend review',
    subscription_memories: 'Friend memories',
    event_memories_shared: 'Attendee memories',
    event_reminder: 'Reminder',
    event_review_prompt: 'Review prompt',
    event_ticket_prompt: 'Ticket prompt',
    event_memories_prompt: 'Memories prompt',
    event_message: 'Message',
    event_message_reply: 'Message reply',
    promo_code_added: 'Promo code',
};

type KindRow = AdminEventNotificationStats['by_kind'][number];

function plural(n: number, word: string) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function channelSummary(row: KindRow) {
    const part = (sent: number, label: string, engaged: number, verb: string) =>
        sent > 0 ? `${sent} ${label} (${engaged} ${verb})` : `0 ${label}`;
    return [
        part(row.app, 'in-app', row.app_reads, 'read'),
        part(row.email, 'email', row.email_clicks, 'clicked'),
        part(row.push, 'push', row.push_opens, 'opened'),
    ].join(' · ');
}

interface Props {
    event: CalendarEvent;
}

/** Saved-search matches + notifications sent about one event (admin). */
export default function AdminEventNotificationsSection({ event }: Props) {
    const [stats, setStats] = useState<AdminEventNotificationStats | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);

    // Depends on the whole event so any saved edit (tags, location, review status) refetches.
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(false);
        fetchAdminEventNotificationStats(event.event_id)
            .then((s) => { if (!cancelled) setStats(s); })
            .catch(() => { if (!cancelled) setError(true); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [event]);

    if (!stats) {
        return (
            <p className="py-2 text-xs text-muted">
                {error ? 'Failed to load notification stats.' : 'Loading…'}
            </p>
        );
    }

    const { interest, by_kind, total_users } = stats;
    // Matching users not notified yet; the scan only revisits an event after it is updated.
    const notYet = interest.would_alert_app;
    return (
        <div className="space-y-5 py-3 text-sm text-ink">
            {loading && <p className="text-xs text-muted">Updating…</p>}
            <section className="space-y-1">
                <h4 className="text-xs font-semibold text-ink-soft">Saved searches</h4>
                {interest.eligible ? (
                    <>
                        <p>
                            <strong>{plural(interest.matched_users, 'user')}</strong> match this event
                            <span className="text-ink-soft"> ({plural(interest.matched_profiles, 'saved search')})</span>
                        </p>
                        {interest.matched_users > 0 && (
                            <p className="text-ink-soft">
                                {interest.matched_users - notYet} notified · {notYet} not notified yet
                            </p>
                        )}
                        {notYet > 0 && (
                            <p className="text-xs text-muted">
                                They'll be alerted the next time this event is updated ({interest.would_alert_app} in-app,
                                {' '}{interest.would_alert_email} email, {interest.would_alert_push} push).
                            </p>
                        )}
                    </>
                ) : (
                    <p className="text-ink-soft">
                        No saved-search alerts: {interest.ineligible_reason}.
                        {interest.already_notified_users > 0 &&
                            ` ${plural(interest.already_notified_users, 'user')} notified earlier.`}
                    </p>
                )}
            </section>
            <section className="space-y-1">
                <h4 className="text-xs font-semibold text-ink-soft">Sent about this event</h4>
                {by_kind.length === 0 ? (
                    <p className="text-ink-soft">Nothing sent yet.</p>
                ) : (
                    <>
                        <p className="text-ink-soft">{plural(total_users, 'user')} notified in total</p>
                        <ul className="divide-y divide-card-line">
                            {by_kind.map((row) => (
                                <li key={row.kind} className="py-2">
                                    <div className="flex items-baseline justify-between gap-3">
                                        <span className="font-medium">
                                            {KIND_LABELS[row.kind] ?? row.kind.replace(/_/g, ' ')}
                                        </span>
                                        <span className="text-ink-soft">{plural(row.users, 'user')}</span>
                                    </div>
                                    <p className="text-xs text-ink-soft">{channelSummary(row)}</p>
                                </li>
                            ))}
                        </ul>
                        <p className="text-xs text-muted">
                            Email clicks and push opens only count users who accepted analytics cookies. A combined push
                            counts for every event it covers, including its "+N more".
                        </p>
                    </>
                )}
            </section>
        </div>
    );
}
