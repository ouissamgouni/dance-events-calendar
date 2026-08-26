import { useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { CalendarEvent } from '../types';
import type { MyEventsTab } from '../utils/myEvents';
import { eventPlace } from '../utils/myEvents';
import AttendeeAvatarStack from './AttendeeAvatarStack';
import GoingButton from './GoingButton';
import SaveEventButton from './SaveEventButton';

interface Props {
    event: CalendarEvent;
    sequence: number;
    tab: MyEventsTab;
    hasPrevious: boolean;
    hasNext: boolean;
    onPrevious: () => void;
    onNext: () => void;
    onOpen: () => void;
}

export default function MyEventsMapPreview({ event, sequence, tab, hasPrevious, hasNext, onPrevious, onNext, onOpen }: Props) {
    const pointerStart = useRef<number | null>(null);
    const [imageFailed, setImageFailed] = useState(false);
    const start = new Date(event.start);
    const when = `${start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${event.all_day ? 'All day' : start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;

    const finishSwipe = (clientX: number) => {
        if (pointerStart.current == null) return;
        const distance = clientX - pointerStart.current;
        pointerStart.current = null;
        if (distance < -48 && hasNext) onNext();
        if (distance > 48 && hasPrevious) onPrevious();
    };

    return (
        <div
            role="group"
            aria-label={`Event ${sequence}: ${event.title}`}
            tabIndex={0}
            onPointerDown={(pointerEvent) => { pointerStart.current = pointerEvent.clientX; }}
            onPointerUp={(pointerEvent) => finishSwipe(pointerEvent.clientX)}
            onPointerCancel={() => { pointerStart.current = null; }}
            onKeyDown={(keyEvent) => {
                if (keyEvent.key === 'ArrowLeft' && hasPrevious) onPrevious();
                if (keyEvent.key === 'ArrowRight' && hasNext) onNext();
            }}
            className="absolute inset-x-0 bottom-0 z-[750] rounded-t-card border-t border-line bg-surface px-4 pb-20 pt-4 shadow-xl focus:outline-none"
            data-testid="my-events-map-preview"
        >
            <div className="mx-auto flex max-w-2xl items-center gap-3">
                {event.image_url && !imageFailed && (
                    <img
                        src={event.image_url}
                        alt=""
                        className="h-20 w-16 shrink-0 rounded-card object-cover"
                        onError={() => setImageFailed(true)}
                        data-testid="my-events-preview-image"
                    />
                )}
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-action text-xs font-bold text-white">{sequence}</span>
                        <h3 className="truncate text-sm font-semibold text-ink">{event.title}</h3>
                    </div>
                    <p className="mt-1 text-xs text-ink-soft">{when}</p>
                    <p className="truncate text-xs text-ink-soft">{eventPlace(event)}</p>
                    <div className="mt-2 flex min-h-5 items-center gap-2">
                        <AttendeeAvatarStack eventId={event.event_id} friendsPreview={event.following_friends_preview} size="sm" />
                        {tab === 'saved' && (
                            <div className="ml-auto flex items-center gap-1">
                                <SaveEventButton eventId={event.event_id} appearance="icon" size="sm" />
                                <GoingButton eventId={event.event_id} appearance="icon" size="sm" iconVariant="hand" />
                            </div>
                        )}
                    </div>
                </div>
                <button type="button" onClick={onOpen} aria-label={`Open ${event.title}`} className="inline-flex h-9 w-9 shrink-0 items-center justify-center text-ink-soft hover:text-action">
                    <ChevronRight className="h-5 w-5" aria-hidden="true" />
                </button>
            </div>
        </div>
    );
}
