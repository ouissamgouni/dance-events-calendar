import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { CalendarEvent } from '../types';
import GoingButton from './GoingButton';
import SaveEventButton from './SaveEventButton';
import ShareButton from './ShareButton';
import RateEventButton from './RateEventButton';
import { useFeatureFlags } from '../context/FeatureFlagsContext';

interface Props {
    event: CalendarEvent;
    isPast: boolean;
    shareUrl: string;
    reviewOpenToken?: number;
    onRatingChanged?: () => void;
    eventHasReviews?: boolean;
    /** Open the Discussion tab / composer ("Start discussion"). */
    onPostMessage: () => void;
    /** Optional "Suggest an edit" affordance. */
    onSuggestEdit?: () => void;
}

/**
 * Persistent action dock pinned to the bottom on mobile and presented as a
 * sticky side panel on desktop. Save and I'm going are always present with
 * equal weight to the rest; Review appears inline when the viewer can review,
 * and the remaining actions live in the ••• overflow menu.
 */
export default function EventActionDock({
    event,
    isPast,
    shareUrl,
    reviewOpenToken,
    onRatingChanged,
    eventHasReviews,
    onPostMessage,
    onSuggestEdit,
}: Props) {
    const { showRatings } = useFeatureFlags();
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!menuOpen) return;
        const onDown = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [menuOpen]);

    const reviewInline = showRatings && isPast;

    return (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-blue-100 bg-blue-50 shadow-[0_-2px_10px_rgba(15,23,42,0.06)] lg:sticky lg:inset-auto lg:top-6 lg:z-10 lg:w-fit lg:rounded-card lg:border lg:p-4 lg:shadow-sm">
            <div className="mx-auto flex max-w-[480px] flex-nowrap items-center gap-2 px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:mx-0 lg:w-max lg:flex-col lg:items-stretch lg:px-0 lg:py-0 lg:pb-0">
                <SaveEventButton eventId={event.event_id} appearance="pill" className="shrink-0 border border-line lg:w-full" labelClassName="hidden min-[375px]:inline" />
                <GoingButton eventId={event.event_id} appearance="pill" isPast={isPast} className="shrink-0 border border-line lg:w-full" labelClassName="hidden min-[375px]:inline" />
                {reviewInline && (
                    <RateEventButton
                        eventId={event.event_id}
                        appearance="pill"
                        eventHasReviews={eventHasReviews}
                        autoOpenToken={reviewOpenToken}
                        entryPoint="detail"
                        isEventDetailPage
                        showCount={false}
                        isPast={isPast}
                        onRatingChanged={onRatingChanged}
                        actionStyle
                        className="lg:w-full"
                        labelClassName="hidden min-[375px]:inline"
                    />
                )}
                {!isPast && (
                    <ShareButton
                        eventId={event.event_id}
                        title={event.title}
                        url={shareUrl}
                        labelClassName="hidden min-[375px]:inline"
                        className="flex h-10 shrink-0 items-center gap-2 rounded-field border border-line bg-surface px-2 text-sm text-ink transition hover:bg-canvas lg:w-full"
                    />
                )}
                <div ref={menuRef} className="relative ml-auto shrink-0 lg:ml-0 lg:w-full">
                    <button
                        type="button"
                        onClick={() => setMenuOpen((o) => !o)}
                        aria-label="More actions"
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-soft transition hover:bg-canvas lg:w-full"
                    >
                        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                    </button>
                    {menuOpen && (
                        <div
                            role="menu"
                            className="absolute right-0 bottom-full z-[12000] mb-1 w-44 rounded-lg border border-line bg-surface py-1 shadow-lg"
                        >
                            {showRatings && !isPast && (
                                <RateEventButton
                                    eventId={event.event_id}
                                    appearance="pill"
                                    eventHasReviews={eventHasReviews}
                                    entryPoint="detail"
                                    isEventDetailPage
                                    showCount={false}
                                    isPast={isPast}
                                    onRatingChanged={onRatingChanged}
                                />
                            )}
                            {isPast && (
                                <ShareButton
                                    eventId={event.event_id}
                                    title={event.title}
                                    url={shareUrl}
                                    onAction={() => setMenuOpen(false)}
                                    className="block w-full px-3 py-2 text-left text-xs text-ink transition hover:bg-canvas"
                                />
                            )}
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => { setMenuOpen(false); onPostMessage(); }}
                                className="block w-full px-3 py-2 text-left text-xs text-ink transition hover:bg-canvas"
                            >
                                Start discussion
                            </button>
                            {onSuggestEdit && (
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { setMenuOpen(false); onSuggestEdit(); }}
                                    className="block w-full px-3 py-2 text-left text-xs text-ink transition hover:bg-canvas"
                                >
                                    Suggest an edit
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
