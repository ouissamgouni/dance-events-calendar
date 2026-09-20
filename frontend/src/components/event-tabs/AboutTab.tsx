import type { CalendarEvent } from '../../types';
import { currencySymbol } from '../../utils/currency';
import { useFeatureFlags } from '../../context/FeatureFlagsContext';
import { isPriceSectionVisible } from '../../utils/sectionVisibility';
import TagBadges from '../TagBadges';
import ExpandableDescription from '../ExpandableDescription';
import EventSeriesLink from '../EventSeriesLink';
import { EventPromoCodes } from '../EventPromoCodes';
import LinksRow from '../event-summary/LinksRow';
import { cleanEventDescription } from '../../utils/eventDescription';

interface Props {
    event: CalendarEvent;
    promoRefreshToken?: number;
}

export function priceRange(event: CalendarEvent): string | null {
    if (event.price_is_free) return 'Free';
    if (event.price_min == null || !event.price_currency) return null;
    const s = currencySymbol(event.price_currency);
    if (event.price_max != null && event.price_max !== event.price_min) {
        return `${s}${event.price_min}–${event.price_max}`;
    }
    return `${s}${event.price_min}`;
}

/** Details tab: description, tags, series, links, price & promo codes. */
export default function AboutTab({ event, promoRefreshToken }: Props) {
    const { showPrices } = useFeatureFlags();
    const price = isPriceSectionVisible(event, showPrices) ? priceRange(event) : null;
    const description = cleanEventDescription(event.description ?? '');
    return (
        <div className="space-y-6">
            {description && (
                <section className="space-y-2">
                    <h3 className="text-sm font-semibold text-ink">About this event</h3>
                    <ExpandableDescription
                        text={description}
                        maxLines={5}
                        moreBackgroundClassName="bg-canvas"
                    />
                </section>
            )}

            {event.tags?.length > 0 && (
                <TagBadges tags={event.tags} maxVisible={Infinity} forceBadge neutral size="sm" />
            )}

            <div id="series" className="scroll-mt-24">
                <EventSeriesLink eventId={event.event_id} />
            </div>

            <LinksRow event={event} />

            {price && (
                <section className="space-y-3">
                    <h3 className="text-lg font-semibold text-ink">Price</h3>
                    <dl className="flex items-center justify-between gap-4 border-y border-card-line py-3 text-sm">
                        <dt className="text-ink-soft">Admission price</dt>
                        <dd className="font-medium text-ink">{price}</dd>
                    </dl>
                </section>
            )}

            <div id="discounts" className="scroll-mt-24">
                <EventPromoCodes event={event} variant="rows" refreshToken={promoRefreshToken} />
            </div>
        </div>
    );
}
