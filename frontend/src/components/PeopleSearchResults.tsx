import type { UserSearchResult } from '../api';
import UserResultCard from './UserResultCard';

export default function PeopleSearchResults({
    term,
    loading,
    results,
    pending,
    onFollow,
    onClear,
}: {
    term: string;
    loading: boolean;
    results: UserSearchResult[] | null;
    pending: string | null;
    onFollow: (handle: string) => void;
    onClear: () => void;
}) {
    return (
        <div>
            <div className="mb-2 flex items-center justify-between">
                <p className="text-xs text-ink-soft">
                    Results for “<span className="text-ink">{term}</span>”
                </p>
                <button
                    type="button"
                    onClick={onClear}
                    className="text-xs font-medium text-action hover:underline"
                >
                    Clear
                </button>
            </div>
            {loading && results === null ? (
                <p className="text-xs text-ink-soft">Searching…</p>
            ) : results && results.length === 0 ? (
                <p className="py-8 text-center text-sm text-ink-soft">No people found.</p>
            ) : (
                <ul className="divide-y divide-line">
                    {results?.map((u) => (
                        <li key={u.handle}>
                            <UserResultCard
                                user={u}
                                variant="rich"
                                href={`/u/${u.handle}`}
                                trailing={
                                    u.is_followed_by_viewer ? (
                                        <span className="text-xs text-ink-soft">Following</span>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.preventDefault();
                                                onFollow(u.handle);
                                            }}
                                            disabled={pending === u.handle}
                                            className="border border-line px-2.5 py-1 text-xs font-semibold text-action hover:bg-canvas disabled:opacity-50"
                                        >
                                            {pending === u.handle ? '…' : 'Follow'}
                                        </button>
                                    )
                                }
                            />
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
