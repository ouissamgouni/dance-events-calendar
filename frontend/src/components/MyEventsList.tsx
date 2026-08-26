import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { CalendarEvent } from '../types';
import type { MyEventsTab } from '../utils/myEvents';
import { eventPlace, groupMyEventsByMonth } from '../utils/myEvents';
import AttendeeAvatarStack from './AttendeeAvatarStack';
import GoingButton from './GoingButton';
import SaveEventButton from './SaveEventButton';

interface Props {
    events: CalendarEvent[];
    tab: MyEventsTab;
    onEventClick: (event: CalendarEvent) => void;
}

function EventImage({ event }: { event: CalendarEvent }) {
    const [failed, setFailed] = useState(false);
    if (!event.image_url || failed) return null;
    return (
        <img
            src={event.image_url}
            alt=""
            className="h-16 w-16 shrink-0 rounded-card object-cover"
            onError={() => setFailed(true)}
            data-testid="my-events-row-image"
        />
    );
}

function MyEventRow({ event, tab, onEventClick }: { event: CalendarEvent; tab: MyEventsTab; onEventClick: (event: CalendarEvent) => void }) {
    const start = new Date(event.start);
    const time = event.all_day
        ? 'All day'
        : start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const place = eventPlace(event);

    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => onEventClick(event)}
            onKeyDown={(keyEvent) => {
                if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
                    keyEvent.preventDefault();
                    onEventClick(event);
                }
            }}
            className="grid min-h-24 grid-cols-[40px_minmax(0,1fr)_24px] items-center gap-3 rounded-card border border-card-line bg-surface px-3 py-3 text-left shadow-sm transition hover:border-line focus:outline-none focus:ring-2 focus:ring-action/30 sm:grid-cols-[44px_minmax(0,1fr)_28px]"
            data-testid="my-events-row"
        >
            <div className="flex flex-col items-center self-start pt-1 leading-none" aria-label={start.toLocaleDateString()}>
                <span className="text-[10px] font-semibold uppercase text-danger">{start.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                <span className="mt-1 text-[10px] font-medium uppercase text-ink-soft">{start.toLocaleDateString(undefined, { month: 'short' })}</span>
                <span className="mt-1 text-xl font-bold text-ink">{start.getDate()}</span>
            </div>
            <div className="flex min-w-0 items-center gap-3">
                <EventImage event={event} />
                <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold text-ink sm:text-base">{event.title}</h3>
                    <p className="mt-1 truncate text-xs text-ink-soft">{[time, place].filter(Boolean).join(' · ')}</p>
                    <div className="mt-2 flex min-h-5 items-center gap-2">
                        <AttendeeAvatarStack eventId={event.event_id} friendsPreview={event.following_friends_preview} size="sm" />
                        {tab === 'saved' && (
                            <div className="ml-auto flex items-center gap-1" onClick={(clickEvent) => clickEvent.stopPropagation()}>
                                <SaveEventButton eventId={event.event_id} appearance="icon" size="sm" stopPropagation />
                                <GoingButton eventId={event.event_id} appearance="icon" size="sm" stopPropagation iconVariant="hand" />
                            </div>
                        )}
                    </div>
                </div>
            </div>
            <ChevronRight className="h-4 w-4 text-muted" aria-hidden="true" />
        </div>
    );
}

export default function MyEventsList({ events, tab, onEventClick }: Props) {
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
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-32 pt-4">
            {groups.map((group) => (
                <section key={group.key} aria-labelledby={`my-events-month-${group.key}`}>
                    <h2 id={`my-events-month-${group.key}`} className="mb-2 text-xs font-semibold text-ink-soft">
                        {group.label}
                    </h2>
                    <div className="space-y-2">
                        {group.events.map((event) => (
                            <MyEventRow key={event.event_id} event={event} tab={tab} onEventClick={onEventClick} />
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}
