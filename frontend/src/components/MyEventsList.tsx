import { useEffect, useState } from 'react';
import { fetchAspectTagGroups, fetchAudienceTagGroups } from '../api';
import type { CalendarEvent, TagGroup } from '../types';
import type { MyEventsTab } from '../utils/myEvents';
import { groupMyEventsByMonth } from '../utils/myEvents';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import EventCard from './EventCard';
import RateEventButton from './RateEventButton';

interface Props {
    events: CalendarEvent[];
    tab: MyEventsTab;
    onEventClick: (event: CalendarEvent) => void;
    showMonthHeadings?: boolean;
}

function MyEventRow({ event, tab, onEventClick, reviewTagLabels }: { event: CalendarEvent; tab: MyEventsTab; onEventClick: (event: CalendarEvent) => void; reviewTagLabels: Map<number, string> }) {
    const { showRatings } = useFeatureFlags();
    const isPast = tab === 'past';
    const isUpcoming = tab === 'upcoming';
    const isSaved = tab === 'saved';
    // Base My Events card keeps picture, title, time and location only.
    // Upcoming adds the avatars stack; Saved adds the "I'm going" button;
    // Past keeps the base plus the rate-event affordance below.
    return (
        <>
            <EventCard
                event={event}
                onOpen={onEventClick}
                followingBadgeEnabled
                showRatings={showRatings}
                isPast={isPast}
                showAvatars={isUpcoming}
                showTags={false}
                showReviews={false}
                showPrice={false}
                showActions={isSaved}
                actions={isSaved ? ['going'] : undefined}
                hideAvatarsIfOnlyCurrentUser={isUpcoming}
                goingIconVariant="hand"
                testId="my-events-row"
            />
            {isPast && (
                <div className="mt-1.5">
                    <RateEventButton
                        eventId={event.event_id}
                        appearance="preview"
                        isPast
                        inlineModal
                        entryPoint="list"
                        reviewTagLabels={reviewTagLabels}
                    />
                </div>
            )}
        </>
    );
}

function labelsByTagId(groups: TagGroup[]): Map<number, string> {
    return new Map(groups.flatMap((group) => group.tags.map((tag) => [tag.id, tag.label] as const)));
}

export default function MyEventsList({ events, tab, onEventClick, showMonthHeadings = true }: Props) {
    const [reviewTagLabels, setReviewTagLabels] = useState<Map<number, string>>(new Map());

    useEffect(() => {
        if (tab !== 'past') return;
        let cancelled = false;
        Promise.all([fetchAspectTagGroups(), fetchAudienceTagGroups()])
            .then(([aspectGroups, audienceGroups]) => {
                if (!cancelled) setReviewTagLabels(labelsByTagId([...aspectGroups, ...audienceGroups]));
            })
            .catch(() => {
                if (!cancelled) setReviewTagLabels(new Map());
            });
        return () => { cancelled = true; };
    }, [tab]);

    const groups = groupMyEventsByMonth(events);
    if (groups.length === 0) {
        const message = tab === 'upcoming'
            ? 'Events you mark as going will appear here.'
            : tab === 'saved'
                ? 'Events you save for later will appear here.'
                : 'Events you attended will appear here.';
        return (
            <div className="px-4 py-20 text-center">
                <p className="text-base font-semibold text-ink">No {tab} events</p>
                <p className="mt-1 text-sm text-ink-soft">{message}</p>
            </div>
        );
    }

    return (
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-24 pt-4">
            {groups.map((group) => (
                <section key={group.key} aria-labelledby={`my-events-month-${group.key}`}>
                    {showMonthHeadings && (
                        <h2 id={`my-events-month-${group.key}`} className="mb-3 text-lg font-semibold text-ink">
                            {group.label}
                        </h2>
                    )}
                    <div className="space-y-2">
                        {group.events.map((event) => (
                            <MyEventRow key={event.event_id} event={event} tab={tab} onEventClick={onEventClick} reviewTagLabels={reviewTagLabels} />
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}
