import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
    CalendarDays,
    ChevronRight,
    Globe2,
    Search,
    Star,
} from 'lucide-react';
import {
    fetchEventsByIds,
    fetchInterestProfiles,
    fetchMyPendingReviews,
    fetchPassport,
    fetchPassportEvents,
} from '../api';
import type {
    CalendarEvent,
    PassportMapEvent,
    PassportMilestone,
    PassportResponse,
} from '../types';
import MyDanceActivityStrip from '../components/MyDanceActivityStrip';
import MyDanceJourneyMap from '../components/MyDanceJourneyMap';
import MilestoneCarousel from '../components/MilestoneCarousel';
import PassportSummaryCard from '../components/PassportSummaryCard';
import SectionHeading from '../components/SectionHeading';
import YourNextEventsRail from '../components/YourNextEventsRail';
import { useAuth } from '../context/AuthContext';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { firstNameOf } from '../utils/displayName';

export function closestMilestone(milestones: PassportMilestone[]): PassportMilestone | null {
    const locked = milestones.filter((milestone) => !milestone.unlocked && milestone.threshold > 0);
    if (locked.length === 0) return null;
    return locked.reduce((best, milestone) =>
        milestone.progress / milestone.threshold > best.progress / best.threshold
            ? milestone
            : best,
    );
}

export function inProgressMilestones(milestones: PassportMilestone[]): PassportMilestone[] {
    return milestones
        .filter((m) => !m.unlocked && m.threshold > 0)
        .sort((a, b) => (b.progress / b.threshold) - (a.progress / a.threshold));
}

interface ShortcutProps {
    title: string;
    status: string;
    to: string;
    icon: ReactNode;
}

function Shortcut({ title, status, to, icon }: ShortcutProps) {
    return (
        <Link
            to={to}
            className="flex min-h-24 items-center rounded-card border border-card-line bg-surface px-4 py-3 shadow-sm transition hover:border-action focus:outline-none focus:ring-2 focus:ring-action"
            aria-label={`${title}, ${status}`}
        >
            <span className="mr-3 shrink-0" aria-hidden="true">{icon}</span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-ink">{title}</span>
                <span className="mt-1 block text-sm text-ink-soft">{status}</span>
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-ink-soft" aria-hidden="true" />
        </Link>
    );
}

function plural(value: number, singular: string, pluralForm = `${singular}s`) {
    return `${value} ${value === 1 ? singular : pluralForm}`;
}

export default function MineHub() {
    const { user } = useAuth();
    const { attendingEventIds, loading: attendingLoading } = useAttendingEvents();
    const [goingEvents, setGoingEvents] = useState<CalendarEvent[]>([]);
    const [passport, setPassport] = useState<PassportResponse | null>(null);
    const [mapEvents, setMapEvents] = useState<PassportMapEvent[]>([]);
    const [pendingReviewCount, setPendingReviewCount] = useState(0);
    const [savedSearchCount, setSavedSearchCount] = useState(0);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!user) {
            setPassport(null);
            setMapEvents([]);
            setPendingReviewCount(0);
            setSavedSearchCount(0);
            setLoading(false);
            return;
        }

        let cancelled = false;
        setLoading(true);
        Promise.all([
            fetchPassport(),
            fetchPassportEvents().catch(() => []),
            fetchMyPendingReviews().catch(() => []),
            fetchInterestProfiles().catch(() => []),
        ])
            .then(([passportData, attendedEvents, pendingReviews, profiles]) => {
                if (cancelled) return;
                setPassport(passportData);
                setMapEvents(attendedEvents);
                setPendingReviewCount(pendingReviews.length);
                setSavedSearchCount(profiles.length);
            })
            .catch(() => {
                if (!cancelled) setPassport(null);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => { cancelled = true; };
    }, [user]);

    useEffect(() => {
        if (attendingEventIds.length === 0) {
            setGoingEvents([]);
            return;
        }

        let cancelled = false;
        fetchEventsByIds(attendingEventIds)
            .then((events) => {
                if (cancelled) return;
                const now = Date.now();
                setGoingEvents(events
                    .filter((event) => new Date(event.start).getTime() > now)
                    .sort((left, right) => new Date(left.start).getTime() - new Date(right.start).getTime()));
            })
            .catch(() => { if (!cancelled) setGoingEvents([]); });
        return () => { cancelled = true; };
    }, [attendingEventIds]);

    const stats = passport?.stats;
    const milestone = passport ? closestMilestone(passport.milestones) : null;
    const displayName = firstNameOf(user?.name, user?.handle) || 'MyDance';
    const coords = useMemo(() => mapEvents.flatMap((event) =>
        event.latitude != null && event.longitude != null
            ? [{ lat: event.latitude, lng: event.longitude }]
            : [],
    ), [mapEvents]);

    return (
        <div className="min-h-full bg-canvas">
            <div className="mx-auto max-w-3xl space-y-4 px-4 py-4">
                <PassportSummaryCard
                    displayName={displayName}
                    handle={user?.handle ?? null}
                    avatarUrl={user?.avatar_url ?? null}
                    eventsCount={stats?.total_events_attended ?? 0}
                    citiesCount={stats?.cities_visited ?? 0}
                    countriesCount={stats?.countries_visited ?? 0}
                    coords={coords}
                    monthlyActivity={passport?.monthly_activity ?? []}
                    mapOverlay={
                        <Link
                            to="/mine/passport"
                            className="flex flex-col items-center gap-0.5 text-white hover:text-white/80 transition focus:outline-none focus:ring-2 focus:ring-white rounded p-1"
                            aria-label="View passport"
                        >
                            <img
                                src="/passport.png"
                                alt=""
                                className="h-5 w-5"
                                style={{ filter: 'invert(1)' }}
                                aria-hidden="true"
                            />
                            <span className="h-0.5 w-2 bg-white/80 rounded-full" aria-hidden="true" />
                        </Link>
                    }
                />

                <YourNextEventsRail
                    events={goingEvents}
                    loading={attendingLoading || loading}
                />

                <MilestoneCarousel milestones={inProgressMilestones(passport?.milestones ?? [])} />

                <section aria-labelledby="my-dance-title">
                    <h2 id="my-dance-title" className="mb-2 text-lg font-bold text-ink">My Dance</h2>
                    <div className="grid grid-cols-2 gap-3">
                        <Shortcut
                            title="My Events"
                            status={`${goingEvents.length} upcoming`}
                            to="/mine/calendar?filter=going"
                            icon={<CalendarDays className="h-9 w-9 text-brand" strokeWidth={1.8} />}
                        />
                        <Shortcut
                            title="Passport"
                            status={plural(stats?.total_events_attended ?? 0, 'event')}
                            to="/mine/passport"
                            icon={<Globe2 className="h-9 w-9 text-action" strokeWidth={1.8} />}
                        />
                        <Shortcut
                            title="Saved searches"
                            status={plural(savedSearchCount, 'search', 'searches')}
                            to="/mine/profiles"
                            icon={<Search className="h-9 w-9 text-brand" strokeWidth={1.8} />}
                        />
                        <Shortcut
                            title="Reviews"
                            status={`${pendingReviewCount} to review`}
                            to="/mine/reviews"
                            icon={<Star className="h-9 w-9 text-action" strokeWidth={1.8} />}
                        />
                    </div>
                </section>
            </div>
        </div>
    );
}
