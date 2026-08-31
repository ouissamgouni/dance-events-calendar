import { ArrowUp } from 'lucide-react';
import type { CalendarEvent } from '../../types';
import { useAttendanceSummary } from '../../context/AttendanceSummariesContext';
import AttendeeAvatarStack from '../AttendeeAvatarStack';

interface Props {
    event: CalendarEvent;
    postsCount: number;
    /** Open the Discussion tab (full page) or navigate there (modal). */
    onOpenPosts: () => void;
}

/**
 * Single-line social-proof row for EventSummary: an avatar stack on the left,
 * a friends/going/saved summary beside it, and a right-aligned Posts
 * affordance. The detailed friends-vs-other breakdown lives in the People tab.
 */
export default function PeopleProofRow({ event, postsCount, onOpenPosts }: Props) {
    const summary = useAttendanceSummary(event.event_id);
    const totalGoing = summary?.total_going ?? event.going_count ?? 0;
    const totalSaved = summary?.total_saved ?? event.saved_count ?? 0;
    const friendsGoing = event.friends_going_count ?? 0;
    const otherGoing = Math.max(totalGoing - friendsGoing, 0);

    if (totalGoing === 0 && totalSaved === 0 && postsCount === 0) return null;

    const goingText = friendsGoing > 0 && otherGoing > 0
        ? `${friendsGoing} friend${friendsGoing === 1 ? '' : 's'} + ${otherGoing} more are going`
        : totalGoing > 0
            ? `${totalGoing} ${totalGoing === 1 ? 'is' : 'are'} going`
            : '';

    return (
        <div className="flex items-center gap-2 text-xs text-ink-soft">
            <AttendeeAvatarStack
                eventId={event.event_id}
                max={3}
                friendsPreview={event.friends_going_preview}
                size="md"
                layout="faces"
                hideIfOnlyCurrentUser
            />
            <span className="min-w-0 truncate">
                {goingText}
                {goingText && totalSaved > 0 && ' · '}
                {totalSaved > 0 && `${totalSaved} saved`}
            </span>
            {postsCount > 0 && (
                <button
                    type="button"
                    onClick={onOpenPosts}
                    className="ml-auto inline-flex shrink-0 items-center gap-1 font-medium text-action hover:underline"
                >
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                    {postsCount} Post{postsCount === 1 ? '' : 's'}
                </button>
            )}
        </div>
    );
}
