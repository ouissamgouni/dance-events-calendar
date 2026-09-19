import SaveEventButton from './SaveEventButton';
import GoingButton from './GoingButton';
import { useAttendanceSummary } from '../context/AttendanceSummariesContext';

interface CardActionClusterProps {
    eventId: string;
    isSavedFlag?: boolean;
    isPast?: boolean;
    /** Show the live saved count next to the Save action. */
    showSaveStats?: boolean;
    /** Show the live going count next to the "I'm going" action. */
    showGoingStats?: boolean;
    /** Which actions to render, in order. Defaults to both. */
    include?: ReadonlyArray<'save' | 'going'>;
    size?: 'sm' | 'md';
    /** Icon style for the going button. */
    goingIconVariant?: 'hand' | 'person';
}

/**
 * CTA cluster for an event card: each action icon is paired with its live
 * count (saved / going), Twitter-style. Counts are hidden when zero so
 * cards with no engagement stay quiet, and each count can be hidden via
 * `showSaveStats` / `showGoingStats`. Single source of truth for the number
 * is the attendance summary — `AttendeeAvatarStack` shows *who*, not *how
 * many*.
 */
export default function CardActionCluster({
    eventId,
    isSavedFlag = false,
    isPast = false,
    showSaveStats = false,
    showGoingStats = false,
    include = ['save', 'going'],
    size = 'sm',
    goingIconVariant,
}: CardActionClusterProps) {
    const summary = useAttendanceSummary(eventId);
    const savedCount = summary?.total_saved ?? 0;
    const goingCount = summary?.total_going ?? 0;
    return (
        <>
            {include.includes('save') && (
                <span className="inline-flex items-center">
                    <SaveEventButton
                        eventId={eventId}
                        appearance="icon"
                        size={size}
                        stopPropagation
                        className={isSavedFlag ? 'text-ink' : ''}
                    />
                    {showSaveStats && savedCount > 0 && (
                        <span className="text-[11px] text-ink-soft -ml-0.5 mr-1 tabular-nums" aria-label={`${savedCount} saved`}>
                            {savedCount}
                        </span>
                    )}
                </span>
            )}
            {include.includes('going') && (
                <span className="inline-flex items-center">
                    <GoingButton
                        eventId={eventId}
                        appearance="icon"
                        size={size}
                        stopPropagation
                        isPast={isPast}
                        iconVariant={goingIconVariant}
                    />
                    {showGoingStats && goingCount > 0 && (
                        <span className="text-[11px] text-action ml-0.5 mr-1 tabular-nums" aria-label={`${goingCount} ${isPast ? 'attended' : 'going'}`}>
                            {goingCount}
                        </span>
                    )}
                </span>
            )}
        </>
    );
}
