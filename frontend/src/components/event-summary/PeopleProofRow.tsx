import type { CalendarEvent } from '../../types';
import { useAttendanceSummary } from '../../context/AttendanceSummariesContext';
import AttendeeAvatarStack from '../AttendeeAvatarStack';

interface Props {
    event: CalendarEvent;
    postsCount: number;
    /** Open the People tab (full page) or navigate there (modal). */
    onOpenPeople: () => void;
    /** Open the Discussion tab (full page) or navigate there (modal). */
    onOpenPosts: () => void;
}

/**
 * Social-proof row for EventSummary: the going summary opens People, while
 * the independent right-aligned Posts affordance opens Discussion.
 */
export default function PeopleProofRow({ event, postsCount, onOpenPeople, onOpenPosts }: Props) {
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
        <div className="flex items-end gap-2">
            {totalGoing > 0 && (
                <button
                    type="button"
                    onClick={onOpenPeople}
                    className="min-w-0 flex-1 space-y-2 text-left hover:text-action"
                >
                    <span className="block text-sm font-semibold leading-5 text-ink-soft">People going</span>
                    <span className="flex items-center gap-2 text-xs text-ink-soft">
                        <AttendeeAvatarStack
                            eventId={event.event_id}
                            max={3}
                            goingFriendsPreview={event.friends_going_preview}
                            size="lg"
                            layout="faces"
                            hideIfOnlyCurrentUser
                        />
                        <span className="min-w-0 truncate">
                            {goingText}
                            {totalSaved > 0 && ` · ${totalSaved} saved`}
                        </span>
                    </span>
                </button>
            )}
            {totalGoing === 0 && totalSaved > 0 && (
                <span className="min-w-0 flex-1 truncate text-xs text-ink-soft">{totalSaved} saved</span>
            )}
            {postsCount > 0 && (
                <button
                    type="button"
                    onClick={onOpenPosts}
                    className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium text-action hover:underline"
                >
                    <img src="/question.png" alt="" aria-hidden="true" className="h-3.5 w-3.5 object-contain" />
                    {postsCount} Post{postsCount === 1 ? '' : 's'}
                </button>
            )}
        </div>
    );
}
