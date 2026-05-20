/**
 * Phase E (E4) — "People you may know" card.
 *
 * Renders friend-of-friend suggestions ranked by mutual-friend count.
 * Each row shows up to 3 mutual-friend handles ("Followed by @alice
 * + 2 more") plus a Follow button. Hidden when there are no
 * suggestions (e.g. viewer has no friends yet, or has already followed
 * everyone reachable through their network).
 */
import { useCallback, useEffect, useState } from 'react';
import {
    fetchMySuggestions,
    followUser,
    type FoFSuggestionItem,
} from '../api';

export default function PeopleYouMayKnowCard() {
    const [items, setItems] = useState<FoFSuggestionItem[] | null>(null);
    const [pending, setPending] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const r = await fetchMySuggestions({ limit: 6 });
            setItems(r.items);
        } catch {
            setItems([]);
        }
    }, []);

    useEffect(() => {
        void load();
        const onChanged = () => void load();
        window.addEventListener('network:changed', onChanged);
        return () => window.removeEventListener('network:changed', onChanged);
    }, [load]);

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

    if (items === null || items.length === 0) return null;

    return (
        <section className="border border-slate-200 bg-white p-6 mb-4">
            <h2 className="text-base font-semibold text-slate-900 mb-3">
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
                                    <span className="text-sm font-medium text-slate-900 truncate">
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
                                </div>
                                <div className="text-xs text-slate-500 truncate">
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
                                className="bg-blue-500 px-3 py-1 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {pending === it.handle ? '…' : 'Follow'}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
