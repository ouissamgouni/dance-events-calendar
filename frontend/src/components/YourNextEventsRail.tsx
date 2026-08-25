import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEvent, FriendMini } from '../types';
import { firstNameOf } from '../utils/displayName';
import { shortLocation } from '../utils/locationShort';

interface YourNextEventsRailProps {
    /** Upcoming events the viewer is attending, sorted by start date ascending. */
    events: CalendarEvent[];
    onEventClick: (event: CalendarEvent) => void;
    className?: string;
    loading?: boolean;
}

function FriendAvatar({ friend, index }: { friend: FriendMini; index: number }) {
    const name = firstNameOf(friend.display_name, friend.handle) || 'Friend';
    const className = `${index === 0 ? '' : '-ml-2'} h-6 w-6 shrink-0 rounded-full object-cover ring-2 ring-white`;

    if (friend.avatar_url) {
        return <img src={friend.avatar_url} alt={name} title={name} className={className} referrerPolicy="no-referrer" />;
    }

    return (
        <span
            className={`${className} flex items-center justify-center bg-blue-50 text-[10px] font-semibold text-action`}
            title={name}
            aria-label={name}
        >
            {name.charAt(0).toUpperCase()}
        </span>
    );
}

function FriendsGoing({ event }: { event: CalendarEvent }) {
    const friends = event.friends_going_preview ?? [];
    const total = Math.max(event.friends_going_count ?? 0, friends.length);
    if (total === 0) return null;

    const firstName = friends[0] ? firstNameOf(friends[0].display_name, friends[0].handle) : '';
    const additional = Math.max(0, total - 1);
    const copy = firstName
        ? additional > 0
            ? `${firstName} +${additional} ${additional === 1 ? 'friend' : 'friends'} going`
            : `${firstName} is going`
        : `${total} ${total === 1 ? 'friend' : 'friends'} going`;

    return (
        <span className="mt-5 flex min-w-0 items-center gap-2 text-xs font-medium text-white/90" data-testid="your-next-event-friends">
            {friends.length > 0 && (
                <span className="flex shrink-0" aria-hidden="true">
                    {friends.slice(0, 3).map((friend, index) => (
                        <FriendAvatar key={friend.user_id} friend={friend} index={index} />
                    ))}
                </span>
            )}
            <span className="truncate">{copy}</span>
        </span>
    );
}

function NextEventCard({ event, onClick }: { event: CalendarEvent; onClick: (event: CalendarEvent) => void }) {
    const [imageFailed, setImageFailed] = useState(false);
    useEffect(() => setImageFailed(false), [event.event_id, event.image_url]);

    const start = new Date(event.start);
    const end = new Date(event.end);
    const location = shortLocation(event.location);
    const showImage = !!event.image_url && !imageFailed;
    const startLabel = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const timeLabel = event.all_day
        ? 'All day'
        : `${start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} – ${end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
    const tags = event.tags.filter((tag) => tag.enabled).slice(0, 2).map((tag) => tag.label).join(' · ');

    return (
        <button
            type="button"
            onClick={() => onClick(event)}
            aria-label={`Open ${event.title}, your next event on ${startLabel}`}
            className="group relative flex w-full overflow-hidden rounded-card bg-brand text-left text-white shadow-sm transition focus:outline-none focus:ring-2 focus:ring-action focus:ring-offset-2"
            data-testid="your-next-event-card"
        >
            {showImage && (
                <img
                    src={event.image_url ?? undefined}
                    alt=""
                    aria-hidden="true"
                    className="absolute inset-0 h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
                    onError={() => setImageFailed(true)}
                    draggable={false}
                    data-testid="your-next-event-image"
                />
            )}
            <span className="absolute inset-0 bg-black/60 transition group-hover:bg-black/50" aria-hidden="true" />
            <span className="relative flex min-w-0 flex-1 p-3.5">
                <span className="flex h-fit w-11 shrink-0 flex-col items-center rounded-lg bg-black/35 px-1 py-2 text-center font-bold uppercase leading-none backdrop-blur-sm" aria-hidden="true">
                    <span className="text-[10px]">{start.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                    <span className="mt-1 text-[10px]">{start.toLocaleDateString(undefined, { month: 'short' })}</span>
                    <span className="mt-1 text-lg">{start.getDate()}</span>
                </span>
                <span className="ml-3 flex min-w-0 flex-1 flex-col">
                    <span className="line-clamp-2 text-lg font-bold leading-5 text-white">{event.title}</span>
                    <span className="mt-2 text-[13px] font-semibold text-white/95">{timeLabel}</span>
                    {location && <span className="mt-1 truncate text-[13px] text-white/90">{location}</span>}
                    {tags && <span className="mt-1 text-[13px] font-medium text-white/90">{tags}</span>}
                    <FriendsGoing event={event} />
                </span>
            </span>
        </button>
    );
}

export default function YourNextEventsRail({ events, onEventClick, className = '', loading = false }: YourNextEventsRailProps) {
    if (loading) return null;

    const nextEvent = events[0];

    return (
        <section className={className} data-testid="your-next-events-rail">
            <div className="flex w-full items-center justify-between py-1 text-base font-semibold text-ink">
                <span>Your next event</span>
                {events.length > 0 && (
                    <Link
                        to="/mine/calendar?filter=going"
                        className="text-[13px] font-medium text-action hover:text-action-strong focus:outline-none focus:underline"
                        data-testid="your-next-events-more"
                    >
                        {events.length} upcoming
                    </Link>
                )}
            </div>
            {nextEvent ? (
                <div className="py-2">
                    <NextEventCard event={nextEvent} onClick={onEventClick} />
                </div>
            ) : (
                <div className="flex items-start gap-3 rounded-card border border-card-line bg-canvas p-3.5" data-testid="your-next-events-empty">
                    <img src="/no-calendar.png" alt="" className="h-5 w-5 shrink-0" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <p className="text-[15px] font-semibold text-ink">No upcoming events</p>
                        <p className="mt-0.5 text-[13px] text-ink-soft">Find your next dance event</p>
                    </div>
                    <Link to="/" className="shrink-0 text-[13px] font-medium text-action hover:text-action-strong focus:outline-none focus:underline">
                        Explore →
                    </Link>
                </div>
            )}
        </section>
    );
}
