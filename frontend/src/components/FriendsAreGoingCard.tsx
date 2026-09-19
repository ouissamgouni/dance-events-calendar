import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEvent, FriendMini } from '../types';
import { firstNameOf } from '../utils/displayName';
import { shortLocation } from '../utils/locationShort';
import SaveEventButton from './SaveEventButton';
import GoingButton from './GoingButton';

interface FriendsAreGoingCardProps {
    event: CalendarEvent;
    onClick: (event: CalendarEvent) => void;
}

function formatDateRange(startValue: string, endValue: string): string {
    const start = new Date(startValue);
    const end = new Date(endValue);
    const startMonth = start.toLocaleDateString(undefined, { month: 'short' });
    const endMonth = end.toLocaleDateString(undefined, { month: 'short' });
    const startDay = start.getDate();
    const endDay = end.getDate();

    if (start.toDateString() === end.toDateString()) return `${startMonth} ${startDay}`;
    if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
        return `${startMonth} ${startDay}\u2013${endDay}`;
    }
    return `${startMonth} ${startDay}\u2013${endMonth} ${endDay}`;
}

function friendName(friend: FriendMini): string {
    return firstNameOf(friend.display_name, friend.handle) || 'Friend';
}

const FRIEND_AVATAR_SIZE = 'h-[20px] w-[20px]';
const FRIEND_AVATAR_GAP = '-ml-1';

function Avatar({ friend, index }: { friend: FriendMini; index: number }) {
    const name = friendName(friend);
    const content = friend.avatar_url ? (
        <img
            src={friend.avatar_url}
            alt={name}
            className={`${FRIEND_AVATAR_SIZE} rounded-full object-cover ring-2 ring-white`}
            referrerPolicy="no-referrer"
        />
    ) : (
        <span className={`flex ${FRIEND_AVATAR_SIZE} items-center justify-center rounded-full bg-blue-50 text-[9px] font-semibold text-action ring-2 ring-white`}>
            {name.charAt(0).toUpperCase()}
        </span>
    );

    const className = `${index === 0 ? '' : FRIEND_AVATAR_GAP} relative block ${FRIEND_AVATAR_SIZE} shrink-0 before:absolute before:-inset-1 before:content-['']`;
    if (!friend.handle) {
        return <span className={className}>{content}</span>;
    }
    return (
        <Link
            to={`/u/${friend.handle}`}
            aria-label={`Open ${name}'s profile`}
            className={className}
            onClick={(event) => event.stopPropagation()}
        >
            {content}
        </Link>
    );
}

export default function FriendsAreGoingCard({ event, onClick }: FriendsAreGoingCardProps) {
    const [imageFailed, setImageFailed] = useState(false);
    const friends = event.friends_going_preview ?? [];
    const totalFriends = Math.max(event.friends_going_count ?? friends.length, friends.length);
    const shownFriends = friends.slice(0, 3);
    const namedFriends = friends.slice(0, Math.min(3, totalFriends));
    const names = namedFriends.map(friendName).join(', ') || 'Friends';
    const additionalFriends = Math.max(0, totalFriends - namedFriends.length);
    const socialCopy = totalFriends <= 1
        ? 'is going to'
        : additionalFriends === 0
            ? 'are going to'
            : `${additionalFriends === 1 ? 'friend is' : 'friends are'} going to`;
    const overflow = Math.max(0, totalFriends - shownFriends.length);
    const location = shortLocation(event.location);
    const metadata = [formatDateRange(event.start, event.end), location].filter(Boolean).join(' \u00b7 ');
    const showImage = !!event.image_url && !imageFailed;

    const openEvent = () => onClick(event);
    const handleKeyDown = (keyboardEvent: KeyboardEvent<HTMLElement>) => {
        if (keyboardEvent.target !== keyboardEvent.currentTarget) return;
        if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
            keyboardEvent.preventDefault();
            openEvent();
        }
    };
    const handleNestedEventClick = (mouseEvent: MouseEvent<HTMLButtonElement>) => {
        mouseEvent.stopPropagation();
        openEvent();
    };

    return (
        <article
            role="link"
            tabIndex={0}
            aria-label={`Open ${event.title}`}
            onClick={openEvent}
            onKeyDown={handleKeyDown}
            className="group relative flex h-[150px] w-[240px] shrink-0 snap-start cursor-pointer flex-col rounded-card border border-card-line bg-surface px-2.5 py-2.5 text-left shadow-sm transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-action"
            data-testid="friends-going-card"
        >
            <div className="absolute top-1 right-1 z-10 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <SaveEventButton eventId={event.event_id} appearance="icon" size="sm" stopPropagation className="text-ink-soft hover:text-ink" />
                <GoingButton eventId={event.event_id} appearance="icon" size="sm" stopPropagation className="text-ink-soft hover:text-ink" />
            </div>

            <div className={`flex h-[30px] items-center ${showImage ? 'pr-20' : ''}`}>
                <div className="flex items-center" data-testid="friends-going-avatars">
                    {shownFriends.map((friend, index) => (
                        <Avatar key={friend.user_id} friend={friend} index={index} />
                    ))}
                    {overflow > 0 && (
                        <Link
                            to={`/event/${event.event_id}#attendees`}
                            aria-label={`See ${overflow} more friends going`}
                            className={`relative ${FRIEND_AVATAR_GAP} flex ${FRIEND_AVATAR_SIZE} shrink-0 items-center justify-center rounded-full bg-canvas text-[9px] font-semibold text-ink-soft ring-2 ring-white before:absolute before:-inset-1 before:content-[''] hover:text-action`}
                            onClick={(linkEvent) => linkEvent.stopPropagation()}
                        >
                            +{overflow}
                        </Link>
                    )}
                </div>
            </div>

            {showImage && (
                <img
                    src={event.image_url ?? undefined}
                    alt=""
                    aria-hidden="true"
                    className="absolute right-[14px] top-[14px] h-[76px] w-[68px] rounded-lg object-cover"
                    onError={() => setImageFailed(true)}
                    draggable={false}
                    data-testid="friends-going-event-image"
                />
            )}

            <div className={`mt-1.5 min-w-0 flex flex-col gap-1 ${showImage ? 'pr-20' : ''}`}>
                <p className="truncate text-[12px] font-semibold leading-[15px] text-ink" title={names}>{names}</p>
                <p className="truncate text-[12px] leading-[15px] text-ink-soft">
                    {additionalFriends > 0 && (
                        <span className="text-[11px] font-semibold leading-[15px] text-ink">+{additionalFriends}</span>
                    )}
                    {additionalFriends > 0 ? ` ${socialCopy}` : socialCopy}
                </p>
                <button
                    type="button"
                    onClick={handleNestedEventClick}
                    className="block max-w-full truncate text-left text-[12px] font-semibold leading-[15px] text-action hover:text-action-strong focus:outline-none focus:underline"
                    title={event.title}
                    style={{ maxWidth: '100%' }}
                >
                    {event.title}
                </button>
            </div>

            <div className="mt-3 flex items-center justify-between gap-1.5">
                <div className="flex min-w-0 items-center gap-1 truncate text-[11px] leading-3 text-ink-soft" title={metadata}>
                    <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3 shrink-0" aria-hidden="true">
                        <rect x="3.5" y="5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
                        <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    </svg>
                    <span className="truncate text-[11px]">{metadata}</span>
                </div>
            </div>
        </article>
    );
}
