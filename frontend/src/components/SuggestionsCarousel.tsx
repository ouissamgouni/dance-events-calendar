/**
 * "Suggestions for you" carousel on the People page.
 *
 * Reuses the friend-of-friend suggestions endpoint. Renders a compact
 * horizontally-scrollable row of small cards (avatar, name, reason,
 * Follow). The refresh control fetches a fresh batch in place; "See all"
 * routes to the full discovery surface. The component renders nothing
 * when there are no suggestions.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchMySuggestions, followUser, type FoFSuggestionItem } from '../api';
import ScrollDotsIndicator from './ScrollDots';
import { useScrollDots } from '../hooks/useScrollDots';

const BATCH = 12;

export default function SuggestionsCarousel() {
    const navigate = useNavigate();
    const [items, setItems] = useState<FoFSuggestionItem[] | null>(null);
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [refreshing, setRefreshing] = useState(false);
    const [pending, setPending] = useState<string | null>(null);
    const railRef = useRef<HTMLDivElement>(null);
    const dots = useScrollDots(railRef, [items?.length ?? 0]);

    const load = useCallback(async (nextOffset: number) => {
        const r = await fetchMySuggestions({ limit: BATCH, offset: nextOffset });
        // Wrap back to the start when a rotated offset overran the pool.
        if (r.items.length === 0 && nextOffset > 0) {
            const first = await fetchMySuggestions({ limit: BATCH, offset: 0 });
            setItems(first.items);
            setTotal(first.total);
            setOffset(0);
            return;
        }
        setItems(r.items);
        setTotal(r.total);
        setOffset(nextOffset);
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- initial async load of suggestions
        void load(0).catch(() => setItems([]));
        const onChanged = () => void load(0).catch(() => setItems([]));
        window.addEventListener('network:changed', onChanged);
        return () => window.removeEventListener('network:changed', onChanged);
    }, [load]);

    const onRefresh = useCallback(async () => {
        if (refreshing) return;
        setRefreshing(true);
        try {
            const next = total > BATCH ? (offset + BATCH) % total : 0;
            await load(next);
            railRef.current?.scrollTo({ left: 0 });
        } catch {
            /* keep current batch on failure */
        } finally {
            setRefreshing(false);
        }
    }, [refreshing, total, offset, load]);

    const onFollow = useCallback(async (handle: string) => {
        setPending(handle);
        try {
            await followUser(handle);
            setItems((prev) => (prev ? prev.filter((it) => it.handle !== handle) : prev));
            window.dispatchEvent(new Event('network:changed'));
        } catch {
            /* leave the card in place on failure */
        } finally {
            setPending(null);
        }
    }, []);

    if (items !== null && items.length === 0) return null;

    return (
        <section aria-label="Suggestions for you" className="mb-5">
            <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink">Suggestions for you</h2>
                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        onClick={() => void onRefresh()}
                        disabled={refreshing}
                        aria-label="Refresh suggestions"
                        title="Refresh suggestions"
                        className="text-ink-soft hover:text-ink disabled:opacity-50"
                    >
                        <RefreshIcon spinning={refreshing} />
                    </button>
                    <button
                        type="button"
                        onClick={() => navigate('/tribe/discover')}
                        className="text-xs font-medium text-action hover:underline"
                    >
                        See all
                    </button>
                </div>
            </div>
            <div
                ref={railRef}
                className="flex gap-3 overflow-x-auto scrollbar-none scroll-smooth"
            >
                {items === null
                    ? Array.from({ length: 4 }, (_, i) => (
                        <div key={i} className="w-20 shrink-0 animate-pulse">
                            {/* eslint-disable-next-line no-restricted-syntax -- circular avatar skeleton */}
                            <div className="mx-auto h-12 w-12 rounded-full bg-slate-200" />
                        </div>
                    ))
                    : items.map((s) => (
                        <SuggestionCard
                            key={s.handle}
                            item={s}
                            pending={pending === s.handle}
                            onFollow={() => void onFollow(s.handle)}
                        />
                    ))}
            </div>
            <ScrollDotsIndicator
                count={dots.dotCount}
                activeIndex={dots.activeIndex}
                onSelect={dots.scrollToIndex}
                label="Suggestions pages"
            />
        </section>
    );
}

function SuggestionCard({
    item,
    pending,
    onFollow,
}: {
    item: FoFSuggestionItem;
    pending: boolean;
    onFollow: () => void;
}) {
    const name = item.display_name || `@${item.handle}`;
    const initial = name.trim().charAt(0).toUpperCase();
    const reason =
        item.mutual_friend_count > 0
            ? `${item.mutual_friend_count} mutual`
            : `@${item.handle}`;
    return (
        <div className="w-20 shrink-0 text-center">
            <Link to={`/u/${item.handle}`} className="block">
                {item.avatar_url ? (
                    <img
                        src={item.avatar_url}
                        alt=""
                        // eslint-disable-next-line no-restricted-syntax -- circular avatar
                        className="mx-auto h-12 w-12 rounded-full bg-slate-100 object-cover"
                    />
                ) : (
                    // eslint-disable-next-line no-restricted-syntax -- circular avatar placeholder
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-ink-soft">
                        {initial}
                    </div>
                )}
                <div className="mt-1 truncate text-xs font-medium text-ink">{name}</div>
                <div className="truncate text-[11px] text-ink-soft">{reason}</div>
            </Link>
            <button
                type="button"
                onClick={onFollow}
                disabled={pending}
                className="mt-1.5 w-full border border-line px-1 py-0.5 text-[11px] font-semibold text-action hover:bg-canvas disabled:opacity-50"
            >
                {pending ? '…' : 'Follow'}
            </button>
        </div>
    );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={spinning ? 'animate-spin' : ''}
        >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
        </svg>
    );
}
