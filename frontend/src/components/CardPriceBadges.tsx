import type { CalendarEvent } from '../types';
import { formatEventPrice } from '../utils/eventPrice';

/** Compact price chip for event cards (free / single / range). */
export function PriceBadge({ event }: { event: CalendarEvent }) {
    const price = formatEventPrice(event, { repeatCurrency: true });
    if (!price) return null;

    return (
        <span className="inline-flex items-center gap-1 bg-slate-100 px-1.5 py-px text-[10px] font-medium leading-3 text-ink-soft">
            <img src="/price-tag.png" alt="" aria-hidden="true" className="w-2.5 h-2.5 object-contain" />
            {price}
        </span>
    );
}

/** Marker chip shown when an event has active promo codes. */
export function DiscountBadge() {
    return (
        <span
            className="inline-flex items-center gap-1 bg-amber-50 px-1.5 py-px text-[10px] font-medium leading-3 text-amber-700"
            title="Has promo codes"
            data-testid="event-card-promo-icon"
        >
            <img src="/promo-code.png" alt="" aria-hidden="true" className="w-2.5 h-2.5 object-contain" />
            Discount
        </span>
    );
}
