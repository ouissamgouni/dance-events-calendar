import type { ReactNode } from 'react';
import { ChevronRight, MapPin, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { CalendarEvent, FriendMini } from '../types';
import { firstNameOf } from '../utils/displayName';
import { shortLocation } from '../utils/locationShort';

interface NextUpEventCardProps {
    event: CalendarEvent;
    friendsVariant?: 'count' | 'avatars';
    onClick?: (event: CalendarEvent) => void;
    testId?: string;
    to?: string;
}

function countdownLabel(startIso: string): string {
    const milliseconds = new Date(startIso).getTime() - Date.now();
    const days = Math.ceil(milliseconds / 86_400_000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days < 14) return `In ${days} days`;
    const weeks = Math.round(days / 7);
    return `In ${weeks} ${weeks === 1 ? 'week' : 'weeks'}`;
}

function FriendAvatar({ friend, index }: { friend: FriendMini; index: number }) {
    const name = firstNameOf(friend.display_name, friend.handle) || 'Friend';
    const className = `${index === 0 ? '' : '-ml-1.5'} h-5 w-5 shrink-0 rounded-full object-cover ring-1 ring-white`;

    if (friend.avatar_url) {
        return <img src={friend.avatar_url} alt={name} title={name} className={className} referrerPolicy="no-referrer" />;
    }

    return (
        <span
            className={`${className} flex items-center justify-center bg-blue-50 text-[9px] font-semibold text-action`}
            title={name}
            aria-label={name}
        >
            {name.charAt(0).toUpperCase()}
        </span>
    );
}

function FriendsGoing({ event, variant }: { event: CalendarEvent; variant: 'count' | 'avatars' }) {
    const friends = event.friends_going_preview ?? [];
    const total = Math.max(event.friends_going_count ?? 0, friends.length);
    if (total === 0) return null;

    if (variant === 'count') {
        return (
            <span className="flex items-center gap-1.5 text-ink-soft">
                <Users className="h-4 w-4" aria-hidden="true" />
                {total} {total === 1 ? 'friend' : 'friends'} going
            </span>
        );
    }

    const visibleFriends = friends.slice(0, 3);
    const remaining = Math.max(0, total - visibleFriends.length);
    const copy = remaining > 0
        ? `+${remaining} ${remaining === 1 ? 'friend' : 'friends'} going`
        : `${total} ${total === 1 ? 'friend' : 'friends'} going`;

    return (
        <span className="flex min-w-0 items-center gap-1.5 text-ink-soft" data-testid="your-next-event-friends">
            {visibleFriends.length > 0 && (
                <span className="flex shrink-0" data-testid="next-up-avatar-stack">
                    {visibleFriends.map((friend, index) => (
                        <FriendAvatar key={friend.user_id} friend={friend} index={index} />
                    ))}
                </span>
            )}
            <span className="truncate">{copy}</span>
        </span>
    );
}

function CardContent({ event, friendsVariant }: Pick<NextUpEventCardProps, 'event' | 'friendsVariant'>) {
    const start = new Date(event.start);
    const location = shortLocation(event.location);

    return (
        <>
            <span className="flex w-16 shrink-0 flex-col items-center border-r border-brand/25 pr-4 text-center font-bold uppercase text-brand">
                <span className="text-xs">{start.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                <span className="mt-2 text-xs">{start.toLocaleDateString(undefined, { month: 'short' })}</span>
                <span className="mt-1 text-3xl leading-none">{start.getDate()}</span>
            </span>
            <span className="min-w-0 flex-1 pl-4">
                <span className="line-clamp-2 block text-lg font-bold leading-6">{event.title}</span>
                {location && (
                    <span className="mt-2 flex items-center gap-1.5 truncate text-sm font-medium text-ink-soft">
                        <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="truncate">{location}</span>
                    </span>
                )}
                <span className="mt-3 flex min-w-0 items-center gap-2 text-xs">
                    <span className="shrink-0 bg-brand/10 px-2 py-1 font-semibold text-brand" data-testid="next-up-countdown">
                        {countdownLabel(event.start)}
                    </span>
                    <FriendsGoing event={event} variant={friendsVariant ?? 'count'} />
                </span>
            </span>
            <ChevronRight className="ml-2 h-6 w-6 shrink-0 text-brand" aria-hidden="true" />
        </>
    );
}

const cardClassName = 'flex min-h-32 w-full items-center rounded-card bg-brand/10 px-4 py-3 text-left text-ink transition hover:bg-brand/15 focus:outline-none focus:ring-2 focus:ring-action';

export default function NextUpEventCard({
    event,
    friendsVariant = 'count',
    onClick,
    testId = 'next-up-event-card',
    to,
}: NextUpEventCardProps) {
    const label = `Open ${event.title} event details`;
    const content: ReactNode = <CardContent event={event} friendsVariant={friendsVariant} />;

    if (to) {
        return (
            <Link to={to} className={cardClassName} aria-label={label} data-testid={testId}>
                {content}
            </Link>
        );
    }

    return (
        <button
            type="button"
            onClick={() => onClick?.(event)}
            className={cardClassName}
            aria-label={label}
            data-testid={testId}
        >
            {content}
        </button>
    );
}
