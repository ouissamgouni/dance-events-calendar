/**
 * Phase E (E4) — "People you may know" card.
 *
 * Renders friend-of-friend suggestions ranked by mutual-friend count.
 * Each row shows up to 3 mutual-friend handles ("Followed by @alice
 * + 2 more") plus a Follow button. Hidden when there are no
 * suggestions (e.g. viewer has no friends yet, or has already followed
 * everyone reachable through their network).
 * The /for-you "Build your tribe" trail lives in PeopleSuggestionsTrail.
 */
import { useCallback, useEffect, useState } from 'react';
import {
    dismissSuggestion,
    fetchMySuggestions,
    followUser,
    type FoFSuggestionItem,
} from '../api';

interface PeopleYouMayKnowCardProps {
    /** Called whenever the suggestions list resolves (including empty
     * results), so callers can react to emptiness (e.g. NetworkPanel
     * falling back to a different default tab). */
    onResult?: (items: FoFSuggestionItem[]) => void;
}

export default function PeopleYouMayKnowCard({ onResult }: PeopleYouMayKnowCardProps) {
    const [items, setItems] = useState<FoFSuggestionItem[] | null>(null);
    const [total, setTotal] = useState(0);
    const [loadedCount, setLoadedCount] = useState(0);
    const [loadingMore, setLoadingMore] = useState(false);
    const [pending, setPending] = useState<string | null>(null);
    const pageSize = 6;

    const load = useCallback(async () => {
        try {
            const r = await fetchMySuggestions({ limit: pageSize });
            setItems(r.items);
            setTotal(r.total);
            setLoadedCount(r.items.length);
            onResult?.(r.items);
        } catch {
            setItems([]);
            setTotal(0);
            setLoadedCount(0);
            onResult?.([]);
        }
    }, [pageSize, onResult]);

    useEffect(() => {
        void load();
        const onChanged = () => void load();
        window.addEventListener('network:changed', onChanged);
        return () => window.removeEventListener('network:changed', onChanged);
    }, [load]);

    const loadMore = useCallback(async () => {
        setLoadingMore(true);
        try {
            const r = await fetchMySuggestions({ limit: pageSize, offset: loadedCount });
            setItems((prev) => [...(prev ?? []), ...r.items]);
            setTotal(r.total);
            setLoadedCount((c) => c + r.items.length);
        } finally {
            setLoadingMore(false);
        }
    }, [pageSize, loadedCount]);

    const onFollow = useCallback(async (handle: string) => {
        setPending(handle);
        try {
            await followUser(handle);
            window.dispatchEvent(new CustomEvent('network:changed'));
            setItems((prev) =>
                prev ? prev.filter((it) => it.handle !== handle) : prev,
            );
        } finally {
            setPending(null);
        }
    }, []);

    const onDismiss = useCallback(async (handle: string) => {
        setPending(handle);
        try {
            await dismissSuggestion(handle);
            setItems((prev) =>
                prev ? prev.filter((it) => it.handle !== handle) : prev,
            );
            // The server pool shrinks too, so keep the "Show more" offset aligned.
            setLoadedCount((c) => Math.max(0, c - 1));
            setTotal((n) => Math.max(0, n - 1));
        } finally {
            setPending(null);
        }
    }, []);

    if (items === null || items.length === 0) return null;

    return (
        <section className="border border-line bg-surface p-6 mb-4">
            <h2 className="text-base font-semibold text-ink mb-3">
                People you may know
            </h2>
            <ul className="divide-y divide-slate-100">
                {items.map((it) => {
                    const previewHead = it.mutual_friends_preview[0];
                    const previewRest =
                        it.mutual_friend_count - (previewHead ? 1 : 0);
                    return (
                        <li
                            key={it.handle}
                            className="flex items-center gap-3 py-2"
                        >
                            {it.avatar_url ? (
                                <img
                                    src={it.avatar_url}
                                    alt=""
                                    className="h-9 w-9 rounded-full object-cover"
                                />
                            ) : (
                                <div className="h-9 w-9 rounded-full bg-slate-200" />
                            )}
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1">
                                    <span className="text-sm font-medium text-ink truncate">
                                        {it.display_name || it.handle}
                                    </span>
                                    {it.is_verified_organizer && (
                                        <img
                                            src="/orga.png"
                                            alt=""
                                            title="Verified organizer"
                                            aria-label="Verified organizer"
                                            className="w-3.5 h-3.5 object-contain"
                                        />
                                    )}
                                    {it.is_admin_managed && (
                                        <img
                                            src="/badge.png"
                                            alt=""
                                            title="Curator"
                                            aria-label="Curator"
                                            className="w-3.5 h-3.5 object-contain"
                                        />
                                    )}
                                </div>
                                <div className="text-xs text-ink-soft truncate">
                                    {previewHead ? (
                                        <>
                                            Followed by @{previewHead}
                                            {previewRest > 0 && ` + ${previewRest} more`}
                                        </>
                                    ) : (
                                        <>@{it.handle}</>
                                    )}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => void onFollow(it.handle)}
                                disabled={pending === it.handle}
                                aria-label={`Follow ${it.handle}`}
                                className="bg-action px-3 py-1 text-xs font-medium text-white hover:bg-action disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {pending === it.handle ? '…' : 'Follow'}
                            </button>
                            <button
                                type="button"
                                onClick={() => void onDismiss(it.handle)}
                                disabled={pending === it.handle}
                                aria-label={`Not interested in ${it.handle}`}
                                title="Not interested"
                                className="flex h-7 w-7 items-center justify-center text-xs text-muted hover:text-ink-soft disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                ✕
                            </button>
                        </li>
                    );
                })}
            </ul>
            {loadedCount < total && (
                <button
                    type="button"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                    className="mt-3 w-full border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {loadingMore ? 'Loading…' : 'Show more'}
                </button>
            )}
        </section>
    );
}
