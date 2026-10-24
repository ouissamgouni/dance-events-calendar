import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Shuffle } from 'lucide-react';
import type { FoFSuggestionItem } from '../api';
import ScrollDotsIndicator from './ScrollDots';
import { useScrollDots } from '../hooks/useScrollDots';

interface Props {
    items: FoFSuggestionItem[];
    total: number;
    pending: string | null;
    onFollow: (handle: string) => void;
    onDismiss: (handle: string) => void;
    /** Header row with title + "See all"; the Home sheet renders its own header. */
    showHeader?: boolean;
    testId?: string;
    /** Fires once when the trail first scrolls into view. */
    onSeen?: () => void;
    title?: string;
    /** Shows a control that reshuffles the batch. */
    onRefresh?: () => void;
    refreshing?: boolean;
    /** Called when "Discover people"/"See all" is clicked (e.g. to close a sheet). */
    onSeeMore?: () => void;
}

export const DISCOVER_PEOPLE_PATH = '/people/discover';

export function PeopleRefreshButton({ onRefresh, refreshing = false }: { onRefresh: () => void; refreshing?: boolean }) {
    return (
        <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Shuffle suggestions"
            title="Shuffle suggestions"
            className="flex h-7 w-7 items-center justify-center text-ink-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
            <Shuffle size={16} aria-hidden="true" className={refreshing ? 'animate-pulse' : ''} />
        </button>
    );
}

/**
 * Horizontally scrollable people cards, shared by the For You trail, the Home
 * people sheet and the People page. Always ends with a "Discover people" card.
 */
export default function PeopleSuggestionsTrail({
    items, total, pending, onFollow, onDismiss, showHeader = true, testId, onSeen,
    title = 'Build your tribe', onRefresh, refreshing = false, onSeeMore,
}: Props) {
    const sectionRef = useRef<HTMLElement>(null);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const hasMore = total > items.length;
    const { dotCount, activeIndex, scrollToIndex } = useScrollDots(scrollerRef, [items.length]);
    const wasRefreshing = useRef(false);

    useEffect(() => {
        if (wasRefreshing.current && !refreshing) scrollerRef.current?.scrollTo?.({ left: 0 });
        wasRefreshing.current = refreshing;
    }, [refreshing]);

    useEffect(() => {
        const el = sectionRef.current;
        if (!el || !onSeen || typeof IntersectionObserver === 'undefined') return;
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) {
                onSeen();
                observer.disconnect();
            }
        }, { threshold: 0.5 });
        observer.observe(el);
        return () => observer.disconnect();
    }, [onSeen]);

    return (
        <section ref={sectionRef} data-testid={testId}>
            {showHeader && (
                <div className="flex w-full items-center justify-between border-b border-line px-2.5 py-1 text-sm font-semibold text-ink">
                    <span>{title}</span>
                    <div className="flex items-center gap-2">
                        {onRefresh && <PeopleRefreshButton onRefresh={onRefresh} refreshing={refreshing} />}
                        {hasMore && (
                            <Link to={DISCOVER_PEOPLE_PATH} onClick={onSeeMore} className="text-xs font-semibold text-action hover:underline">
                                See all
                            </Link>
                        )}
                    </div>
                </div>
            )}
            <div ref={scrollerRef} className="flex gap-2 overflow-x-auto scrollbar-hide px-2 py-2" aria-label={title}>
                {items.map((it) => {
                    const name = it.display_name || `@${it.handle}`;
                    const previewHead = it.mutual_friends_preview[0];
                    const previewRest = it.mutual_friend_count - (previewHead ? 1 : 0);
                    return (
                        <div
                            key={it.handle}
                            className="relative flex w-[140px] shrink-0 flex-col items-center gap-1 border border-line bg-surface px-2 py-2 text-center"
                        >
                            <button
                                type="button"
                                onClick={() => onDismiss(it.handle)}
                                disabled={pending === it.handle}
                                aria-label={`Not interested in ${it.handle}`}
                                title="Not interested"
                                className="absolute right-0 top-0 flex h-7 w-7 items-center justify-center text-xs text-muted hover:text-ink-soft disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                ✕
                            </button>
                            <Link to={`/u/${it.handle}`} className="flex flex-col items-center gap-1">
                                {it.avatar_url ? (
                                    // eslint-disable-next-line no-restricted-syntax -- avatar is circular by design
                                    <img src={it.avatar_url} alt="" className="h-8 w-8 rounded-full object-cover" />
                                ) : (
                                    // eslint-disable-next-line no-restricted-syntax -- avatar is circular by design
                                    <div className="h-8 w-8 rounded-full bg-line" />
                                )}
                                <span className="flex max-w-[120px] items-center gap-1 truncate text-xs font-medium text-ink">
                                    {name}
                                    {it.is_verified_organizer && (
                                        <img
                                            src="/orga.png"
                                            alt=""
                                            title="Verified organizer"
                                            aria-label="Verified organizer"
                                            className="h-3 w-3 shrink-0 object-contain"
                                        />
                                    )}
                                    {it.is_admin_managed && (
                                        <img
                                            src="/badge.png"
                                            alt=""
                                            title="Curator"
                                            aria-label="Curator"
                                            className="h-3 w-3 shrink-0 object-contain"
                                        />
                                    )}
                                </span>
                            </Link>
                            <span className="max-w-[120px] truncate text-xs text-ink-soft">
                                {previewHead ? (
                                    <>
                                        Followed by @{previewHead}
                                        {previewRest > 0 && ` + ${previewRest} more`}
                                    </>
                                ) : (
                                    <>@{it.handle}</>
                                )}
                            </span>
                            <button
                                type="button"
                                onClick={() => onFollow(it.handle)}
                                disabled={pending === it.handle}
                                aria-label={`Follow ${it.handle}`}
                                className="w-full bg-action px-2 py-1 text-xs font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {pending === it.handle ? '…' : 'Follow'}
                            </button>
                        </div>
                    );
                })}
                <Link
                    to={DISCOVER_PEOPLE_PATH}
                    onClick={onSeeMore}
                    className="flex w-[140px] shrink-0 flex-col items-center justify-center gap-1 border border-line bg-surface px-2 py-2 text-center text-sm font-semibold text-action hover:bg-canvas"
                >
                    <span aria-hidden="true" className="text-lg leading-none">→</span>
                    Discover people
                </Link>
            </div>
            <ScrollDotsIndicator
                count={dotCount}
                activeIndex={activeIndex}
                onSelect={scrollToIndex}
                label={`${title} scroll position`}
            />
        </section>
    );
}
