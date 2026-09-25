import type { CalendarEvent } from '../../types';
import { useFeatureFlags } from '../../context/FeatureFlagsContext';
import { isPriceSectionVisible } from '../../utils/sectionVisibility';
import { formatEventPrice } from '../../utils/eventPrice';
import TagBadges from '../TagBadges';
import ExpandableDescription from '../ExpandableDescription';
import EventSeriesLink from '../EventSeriesLink';
import { EventPromoCodes } from '../EventPromoCodes';
import LinksRow from '../event-summary/LinksRow';
import { cleanEventDescription, collectEventLinks } from '../../utils/eventDescription';

interface Props {
    event: CalendarEvent;
    promoRefreshToken?: number;
}

/** Details tab: description, tags, links, series, price & promo codes. */
export default function AboutTab({ event, promoRefreshToken }: Props) {
    const { showPrices } = useFeatureFlags();
    const price = isPriceSectionVisible(event, showPrices) ? formatEventPrice(event) : null;
    const description = cleanEventDescription(event.description ?? '');
    const hasLinks = collectEventLinks(event.links, event.description).length > 0;

    return (
        <div className="mx-1 space-y-4 sm:mx-0">
            {description && (
                <section className="space-y-3 rounded-card border border-card-line bg-surface p-4">
                    <h2 className="text-sm font-semibold text-ink">About</h2>
                    <ExpandableDescription
                        text={description}
                        maxLines={6}
                        variant="details"
                    />
                </section>
            )}

            {event.tags?.length > 0 && (
                <section className="space-y-3 rounded-card border border-card-line bg-surface p-4">
                    <h2 className="text-sm font-semibold text-ink">Categories</h2>
                    <TagBadges tags={event.tags} maxVisible={Infinity} forceBadge neutral size="sm" />
                </section>
            )}

            {hasLinks && (
                <section className="rounded-card border border-card-line bg-surface p-4">
                    <LinksRow event={event} />
                </section>
            )}

            <div id="series" className="scroll-mt-24">
                <EventSeriesLink eventId={event.event_id} variant="details" />
            </div>

            {price && (
                <section className="space-y-3 rounded-card border border-card-line bg-surface p-4">
                    <h3 className="text-sm font-semibold text-ink">Price</h3>
                    <dl className="flex items-center justify-between gap-4 text-sm">
                        <dt className="text-ink-soft">Admission price</dt>
                        <dd className="font-semibold text-ink">{price}</dd>
                    </dl>
                </section>
            )}

            <div id="discounts" className="scroll-mt-24">
                <EventPromoCodes event={event} variant="rows" refreshToken={promoRefreshToken} />
            </div>
        </div>
    );
}
