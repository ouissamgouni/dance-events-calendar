import type { CalendarEvent } from '../../types';
import { currencySymbol } from '../../utils/currency';
import TagBadges from '../TagBadges';
import ExpandableDescription from '../ExpandableDescription';
import EventSeriesLink from '../EventSeriesLink';
import { EventPromoCodes } from '../EventPromoCodes';
import LinksRow from '../event-summary/LinksRow';

interface Props {
    event: CalendarEvent;
}

function priceRange(event: CalendarEvent): string | null {
    if (event.price_is_free) return 'Free';
    if (event.price_min == null || !event.price_currency) return null;
    const s = currencySymbol(event.price_currency);
    if (event.price_max != null && event.price_max !== event.price_min) {
        return `${s}${event.price_min}–${event.price_max}`;
    }
    return `${s}${event.price_min}`;
}

/** Details tab: description, tags, series, links, price & promo codes. */
export default function AboutTab({ event }: Props) {
    const price = priceRange(event);
    return (
        <div className="space-y-6">
            {event.description && (
                <section className="space-y-2">
                    <h3 className="text-sm font-semibold text-ink">About this event</h3>
                    <ExpandableDescription text={event.description} clampClass="line-clamp-5" />
                </section>
            )}

            {event.tags?.length > 0 && (
                <TagBadges tags={event.tags} maxVisible={Infinity} forceBadge neutral size="sm" />
            )}

            <div id="series" className="scroll-mt-24">
                <EventSeriesLink eventId={event.event_id} />
            </div>

            <LinksRow event={event} />

            {price ? (
                <section id="discounts" className="scroll-mt-24 space-y-3">
                    <h3 className="text-sm font-semibold text-ink">Price &amp; promo codes</h3>
                    <div>
                        <p className="text-lg font-bold text-ink">{price}</p>
                        <p className="text-xs text-muted">Typical admission price</p>
                    </div>
                    <EventPromoCodes event={event} variant="rows" />
                </section>
            ) : (
                <div id="discounts" className="scroll-mt-24">
                    <EventPromoCodes event={event} variant="rows" />
                </div>
            )}
        </div>
    );
}
