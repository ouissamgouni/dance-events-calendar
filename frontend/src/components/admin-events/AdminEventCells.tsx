import type { CalendarEvent, EventInterestReach } from '../../types';
import { FlagIcon, WantsPublicChip } from '../VisibilityChip';
import { hasOpenChanges } from '../../utils/adminEventStatus';

export function EventFlagIcons({ event }: { event: CalendarEvent }) {
    return (
        <span className="inline-flex items-center gap-1.5">
            {event.visibility_state && <FlagIcon flag={event.visibility_state} />}
            {event.wants_public && <WantsPublicChip />}
            {event.is_submission && <FlagIcon flag="submitted" />}
            {hasOpenChanges(event) && <FlagIcon flag="changes" />}
        </span>
    );
}

export function MatchesCell({ reach }: { reach?: EventInterestReach | null }) {
    if (!reach) return <span className="text-muted">—</span>;
    if (!reach.eligible) {
        return (
            <span
                className="text-muted"
                title={`No saved-search alerts: ${reach.ineligible_reason ?? 'unknown'} · ${reach.already_notified_users} notified earlier`}
            >
                —
            </span>
        );
    }
    if (reach.matched_users === 0) {
        return <span className="text-muted" title="No saved search matches this event">0</span>;
    }
    const notYet = reach.would_alert_app;
    const notified = reach.matched_users - notYet;
    const summary =
        `${notified} of ${reach.matched_users} matching users notified (${reach.matched_profiles} saved searches)` +
        (notYet > 0 ? ` · ${notYet} not notified yet, alerted on next event update` : '');
    return (
        <span className={notYet > 0 ? 'font-medium text-amber-700' : 'text-ink'} title={summary}>
            {notified}/{reach.matched_users}
        </span>
    );
}
