import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { fetchEventsByIds, fetchPassport, fetchMyPendingReviews } from '../api';
import type { CalendarEvent, PassportResponse, PassportMilestone, PendingReview } from '../types';
import { useAuth } from '../context/AuthContext';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import YourNextEventsRail from '../components/YourNextEventsRail';
import ShareExperienceCard from '../components/ShareExperienceCard';
import ScrollDotsIndicator from '../components/ScrollDots';
import EventModal from '../components/EventModal';
import { useScrollDots } from '../hooks/useScrollDots';
import { trackView } from '../utils/tracking';

/** Short "in …" label for an upcoming event start. */
function nextInLabel(startIso: string): string {
    const days = Math.ceil((new Date(startIso).getTime() - Date.now()) / 86_400_000);
    if (days <= 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days < 14) return `in ${days} days`;
    return `in ${Math.round(days / 7)} weeks`;
}

/** Milestone the viewer is closest to unlocking (highest progress ratio among
 * locked ones), or null when everything is unlocked / none exist. */
function nextMilestone(milestones: PassportMilestone[]): PassportMilestone | null {
    const locked = milestones.filter((m) => !m.unlocked && m.threshold > 0);
    if (locked.length === 0) return null;
    return locked.reduce((best, m) =>
        m.progress / m.threshold > best.progress / best.threshold ? m : best,
    );
}

export default function MineHub() {
    const { user } = useAuth();
    const { savedEventIds } = useSavedEvents();
    const { attendingEventIds } = useAttendingEvents();
    const [myEvents, setMyEvents] = useState<CalendarEvent[]>([]);
    const [passport, setPassport] = useState<PassportResponse | null>(null);
    const [pending, setPending] = useState<PendingReview[]>([]);
    const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);

    const allEventIds = useMemo(
        () => [...new Set([...savedEventIds, ...attendingEventIds])],
        [savedEventIds, attendingEventIds],
    );

    useEffect(() => {
        if (allEventIds.length === 0) {
            setMyEvents([]);
            return;
        }
        let cancelled = false;
        fetchEventsByIds(allEventIds)
            .then((evts) => {
                if (cancelled) return;
                const now = Date.now();
                const attendingSet = new Set(attendingEventIds);
                setMyEvents(
                    evts
                        .filter((e) => new Date(e.end).getTime() >= now)
                        .sort((a, b) => {
                            // Events the viewer is going to lead the rail; saved-only trail after.
                            const aGoing = attendingSet.has(a.event_id);
                            const bGoing = attendingSet.has(b.event_id);
                            if (aGoing !== bGoing) return aGoing ? -1 : 1;
                            return new Date(a.start).getTime() - new Date(b.start).getTime();
                        }),
                );
            })
            .catch(() => { if (!cancelled) setMyEvents([]); });
        return () => { cancelled = true; };
    }, [allEventIds, attendingEventIds]);

    useEffect(() => {
        if (!user) {
            setPassport(null);
            setPending([]);
            return;
        }
        let cancelled = false;
        fetchPassport().then((p) => { if (!cancelled) setPassport(p); }).catch(() => { });
        fetchMyPendingReviews().then((r) => { if (!cancelled) setPending(r); }).catch(() => { });
        return () => { cancelled = true; };
    }, [user]);

    const handleEventClick = useCallback((evt: CalendarEvent) => {
        trackView(evt.event_id, 'mine-hub');
        setSelectedEvent(evt);
    }, []);

    const handleReviewed = useCallback((eventId: string) => {
        setPending((prev) => prev.filter((p) => p.event_id !== eventId));
    }, []);

    const shareScrollerRef = useRef<HTMLDivElement>(null);
    const shareDots = useScrollDots(shareScrollerRef, [pending.length]);

    const stats = passport?.stats;
    const milestone = passport ? nextMilestone(passport.milestones) : null;
    const upcomingCount = myEvents.length;
    const nextGoingStart = useMemo(() => {
        const attendingSet = new Set(attendingEventIds);
        return myEvents
            .filter((e) => attendingSet.has(e.event_id))
            .reduce<string | null>(
                (soonest, e) => (!soonest || new Date(e.start) < new Date(soonest) ? e.start : soonest),
                null,
            );
    }, [myEvents, attendingEventIds]);

    return (
        <div className="min-h-full bg-canvas">
            <div className="mx-auto max-w-3xl px-4 py-4 space-y-4">
                {/* Profile / stats header */}
                <header className="bg-brand p-5 text-white">
                    <div className="flex items-center gap-3">
                        {user?.avatar_url ? (
                            <img src={user.avatar_url} alt="" className="h-11 w-11 rounded-full" referrerPolicy="no-referrer" />
                        ) : (
                            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface/20 text-base font-semibold">
                                {user?.name?.[0]?.toUpperCase() ?? '?'}
                            </div>
                        )}
                        <div className="min-w-0">
                            <h1 className="truncate text-lg font-semibold">{user?.name ?? 'You'}</h1>
                            {user?.handle && <p className="truncate text-xs text-white/70">@{user.handle}</p>}
                        </div>
                    </div>
                    {stats && (
                        <p className="mt-3 tabular-nums">
                            <span className="text-2xl font-semibold">
                                {stats.total_events_attended} {stats.total_events_attended === 1 ? 'event' : 'events'}
                            </span>
                            <span className="text-sm font-semibold text-white/80">
                                {' · '}{stats.cities_visited} {stats.cities_visited === 1 ? 'city' : 'cities'}
                                {' · '}{stats.countries_visited} {stats.countries_visited === 1 ? 'country' : 'countries'}
                            </span>
                        </p>
                    )}
                    {upcomingCount > 0 && (
                        <p className="mt-1 text-xs text-white/70">
                            {upcomingCount} {upcomingCount === 1 ? 'event' : 'events'} planned
                            {nextGoingStart && (
                                <> · Next {nextInLabel(nextGoingStart)}</>
                            )}
                        </p>
                    )}
                </header>

                {/* Your next events */}
                <YourNextEventsRail
                    events={myEvents}
                    onEventClick={handleEventClick}
                    emptyState={(
                        <>
                            No upcoming events yet.{' '}
                            <Link to="/" className="font-semibold text-action hover:text-action">Browse events</Link>{' '}
                            and save or mark “I’m going” to build your calendar.
                        </>
                    )}
                />

                {/* Your dancer passport */}
                {milestone && (
                    <section>
                        <div className="flex w-full items-center justify-between border-b border-line px-2.5 py-1 text-base font-semibold text-ink">
                            <span>Your dancer passport</span>
                        </div>
                        <Link to="/mine/passport" className="mt-2 block border border-line bg-surface p-4 hover:border-blue-300 transition">
                            <div className="flex items-center gap-3">
                                <span className="text-2xl" aria-hidden>{milestone.icon || '🏅'}</span>
                                <div className="min-w-0 flex-1">
                                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Next milestone</p>
                                    <p className="truncate text-sm font-semibold text-ink">{milestone.name}</p>
                                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                                        <div
                                            className="h-full rounded-full bg-action"
                                            style={{ width: `${Math.min(100, Math.round((milestone.progress / milestone.threshold) * 100))}%` }}
                                        />
                                    </div>
                                    <p className="mt-1 text-xs text-ink-soft tabular-nums">
                                        {milestone.progress} / {milestone.threshold} {milestone.unit}
                                    </p>
                                </div>
                            </div>
                        </Link>
                    </section>
                )}

                {/* Share your experience */}
                {pending.length > 0 && (
                    <section data-testid="mine-share-your-experience">
                        <div className="flex w-full items-center justify-between border-b border-line px-2.5 py-1 text-base font-semibold text-ink">
                            <span>Share your experience</span>
                        </div>
                        <div ref={shareScrollerRef} className="flex gap-2 overflow-x-auto scrollbar-hide px-2 py-2" aria-label="Share your experience">
                            {pending.map((review) => (
                                <ShareExperienceCard
                                    key={review.event_id}
                                    review={review}
                                    onReviewed={handleReviewed}
                                />
                            ))}
                        </div>
                        <ScrollDotsIndicator
                            count={shareDots.dotCount}
                            activeIndex={shareDots.activeIndex}
                            onSelect={shareDots.scrollToIndex}
                            label="Share your experience scroll position"
                        />
                    </section>
                )}

                {/* Quick links */}
                <section className="border border-line bg-surface p-4">
                    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">Quick links</h2>
                    <div className="flex flex-wrap gap-2">
                        {[
                            { label: 'My Events', to: '/mine/calendar' },
                            { label: 'Passport', to: '/mine/passport' },
                            { label: 'Discovery Profiles', to: '/mine/profiles' },
                            { label: 'Reviews', to: '/mine/reviews' },
                            { label: 'Settings', to: '/account' },
                        ].map((l) => (
                            <Link
                                key={l.to}
                                to={l.to}
                                className="border border-line bg-surface px-2 py-1 text-xs font-medium text-ink hover:border-action hover:text-action transition"
                            >
                                {l.label}
                            </Link>
                        ))}
                    </div>
                </section>
            </div>

            {selectedEvent && (
                <EventModal event={selectedEvent} onClose={() => setSelectedEvent(null)} />
            )}
        </div>
    );
}
