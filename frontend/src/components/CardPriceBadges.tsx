import type { CalendarEvent } from '../types';
import { currencySymbol } from '../utils/currency';

/** Compact price chip for event cards (free / single / range). */
export function PriceBadge({ event }: { event: CalendarEvent }) {
    if (event.price_is_free) {
        return (
            <span className="inline-flex items-center gap-1 bg-slate-100 px-1.5 py-px text-[10px] font-medium leading-3 text-ink-soft">
                <img src="/price-tag.png" alt="" aria-hidden="true" className="w-2.5 h-2.5 object-contain" />
                Free
            </span>
        );
    }
    if (event.price_min != null && event.price_currency) {
        const sign = currencySymbol(event.price_currency);
        const priceText = event.price_max != null && event.price_max !== event.price_min
            ? `${sign}${event.price_min}–${sign}${event.price_max}`
            : `${sign}${event.price_min}`;
        return (
            <span className="inline-flex items-center gap-1 bg-slate-100 px-1.5 py-px text-[10px] font-medium leading-3 text-ink-soft">
                <img src="/price-tag.png" alt="" aria-hidden="true" className="w-2.5 h-2.5 object-contain" />
                {priceText}
            </span>
        );
    }
    return null;
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
