import { Link } from 'react-router-dom';
import type { EventAssetSummary } from '../types';
import { formatAssetDate, memoryStrip, showMemoriesRow } from '../utils/eventAssets';

interface Props {
    eventId: string;
    summary: EventAssetSummary | undefined;
    /** 'tile' renders a compact "+" after the thumbnails instead of the text link. */
    addAffordance?: 'link' | 'tile';
}

export default function MemoriesStrip({ eventId, summary, addAffordance = 'link' }: Props) {
    if (!summary || !showMemoriesRow(summary)) return null;
    const { thumbs, extra } = memoryStrip(summary);
    if (addAffordance === 'tile' && thumbs.length === 0) return null;
    const href = `/event/${encodeURIComponent(eventId)}#memories`;

    return (
        <div className="flex min-h-11 items-center gap-2" data-testid="memories-strip" onClick={(e) => e.stopPropagation()}>
            {thumbs.length > 0 ? (
                <Link to={href} className="flex items-center gap-1" aria-label={`${summary.memory_count} memories`}>
                    {thumbs.map((thumb) => (
                        <span key={thumb.id} className="h-10 w-10 overflow-hidden rounded-field bg-canvas">
                            {thumb.thumb_url && <img src={thumb.thumb_url} alt="" className="h-full w-full object-cover" />}
                        </span>
                    ))}
                    {extra > 0 && <span className="px-1 text-xs font-medium text-ink-soft">+{extra}</span>}
                </Link>
            ) : null}
            {summary.can_add_memory && addAffordance === 'tile' && (
                <Link
                    to={href}
                    aria-label="Add memories"
                    className="flex h-10 w-10 items-center justify-center rounded-field border border-dashed border-line text-lg leading-none text-action"
                >
                    +
                </Link>
            )}
            {summary.can_add_memory && addAffordance === 'link' && (
                <Link
                    to={href}
                    className={`text-xs font-medium text-action hover:underline ${thumbs.length ? 'ml-auto' : 'border border-dashed border-line px-3 py-2'}`}
                >
                    📸 {thumbs.length ? 'Add' : `Add memories · until ${formatAssetDate(summary.memory_window_closes_at ?? '')}`}
                </Link>
            )}
        </div>
    );
}
