import { CalendarX, Clock, MapPin } from 'lucide-react';
import type { CalendarEvent } from '../../types';
import DateBlock from './DateBlock';
import { useFeatureFlags } from '../../context/FeatureFlagsContext';
import { allDayLastDay, eventDisplayZone, isSameEventDay, timeZoneLabel, viewerTimeHint } from '../../utils/eventDates';

interface Props {
    event: CalendarEvent;
    /** `modal` shows city/country; `page` shows the full location string. */
    variant: 'page' | 'modal';
}

/**
 * The event identity block shared by the modal (top of EventSummary) and the
 * full page (rendered above the detail tabs): optional image, date block,
 * title, time line, and location.
 */
export default function SummaryHeader({ event, variant }: Props) {
    const { eventImagesEnabled } = useFeatureFlags();
    // Full-width hero: prefer the uncropped variant over the 16:9 thumb.
    const heroSrc = event.image_url ?? event.image_thumb_url ?? null;
    const hasHero = eventImagesEnabled && !!heroSrc;
    const start = new Date(event.start);
    const end = new Date(event.end);
    const timeZone = eventDisplayZone(event);
    const timeFmt = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone });
    const dayFmt = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone });
    const sameDay = isSameEventDay(event);
    const timeLine = event.all_day
        ? (sameDay ? 'All day' : `${dayFmt(start)} – ${dayFmt(allDayLastDay(event))}`)
        : `${timeFmt(start)} → ${sameDay ? '' : `${dayFmt(end)} · `}${timeFmt(end)}`;
    const viewerHint = viewerTimeHint(event);

    const locationText = variant === 'modal'
        ? [event.city, event.country].filter(Boolean).join(', ') || event.location
        : event.location;

    return (
        <div className={`space-y-3 ${variant === 'page' && hasHero ? 'lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)] lg:items-center lg:gap-8 lg:space-y-0' : ''}`.trim()}>
            {/* No placeholder here: a missing picture simply collapses the hero
                rather than padding the summary with empty artwork. */}
            {hasHero && (
                <img
                    src={heroSrc}
                    alt=""
                    className={`h-[140px] w-full object-cover ${variant === 'page' ? 'lg:aspect-[16/9] lg:h-auto' : ''}`.trim()}
                    data-testid="event-summary-image"
                />
            )}

            <div className="flex gap-3">
                <DateBlock date={start} timeZone={timeZone} />
                <div className="min-w-0 flex-1 space-y-1">
                    <h2 className={`text-xl font-bold leading-snug ${event.is_cancelled ? 'text-ink-soft line-through' : 'text-ink'} ${variant === 'page' ? 'lg:text-3xl' : ''}`.trim()}>{event.title}</h2>
                    <p className="flex items-center gap-1.5 text-xs text-ink-soft">
                        <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 truncate">{timeLine}</span>
                    </p>
                    {viewerHint && event.timezone ? (
                        <p className="pl-5 text-xs text-muted" data-testid="event-viewer-time">
                            {timeZoneLabel(event.timezone, start)} · {viewerHint}
                        </p>
                    ) : null}
                    {locationText && (
                        <p className="flex items-center gap-1.5 text-xs text-ink-soft">
                            <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 truncate">{locationText}</span>
                        </p>
                    )}
                    {event.organizer && (
                        <a
                            href={event.organizer.handle ? `/u/${event.organizer.handle}` : undefined}
                            className="inline-flex max-w-full items-center gap-1.5 bg-canvas px-2 py-1 text-xs text-ink hover:bg-line"
                            data-testid="event-organizer-pill"
                        >
                            {event.organizer.avatar_url && (
                                // eslint-disable-next-line no-restricted-syntax -- circular avatar
                                <img src={event.organizer.avatar_url} alt="" className="h-4 w-4 shrink-0 rounded-full object-cover" />
                            )}
                            <span className="min-w-0 truncate">
                                Organized by{' '}
                                <span className="font-semibold">
                                    {event.organizer.handle ? `@${event.organizer.handle}` : event.organizer.display_name ?? 'organizer'}
                                </span>
                            </span>
                            {event.organizer.is_verified_organizer && (
                                <img src="/orga.png" alt="Verified organizer" title="Verified organizer" className="h-3.5 w-3.5 shrink-0 object-contain" />
                            )}
                        </a>
                    )}
                </div>
            </div>

            {event.is_cancelled && (
                <div role="status" className="flex gap-2 rounded-card border border-danger/20 bg-danger/10 px-3 py-2 lg:col-span-2" data-testid="event-cancelled-banner">
                    <CalendarX className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
                    <div className="min-w-0">
                        <p className="text-sm font-semibold text-danger">This event was cancelled</p>
                        {event.cancellation_note && <p className="mt-0.5 text-sm text-ink">{event.cancellation_note}</p>}
                    </div>
                </div>
            )}
        </div>
    );
}
