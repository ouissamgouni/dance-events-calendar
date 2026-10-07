interface Props {
    shown: number;
    total: number;
    loading: boolean;
    onLoadMore: () => void;
}

/** Mobile pager for admin lists: appends the next page instead of replacing it. */
export default function AdminLoadMore({ shown, total, loading, onLoadMore }: Props) {
    if (total === 0) return null;
    return (
        <div className="flex flex-col items-center gap-2 px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <p className="text-xs text-ink-soft">Showing {Math.min(shown, total)} of {total}</p>
            {shown < total && (
                <button
                    type="button"
                    onClick={onLoadMore}
                    disabled={loading}
                    className="min-h-11 w-full border border-line bg-surface text-sm font-medium text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {loading ? 'Loading…' : 'Load more'}
                </button>
            )}
        </div>
    );
}
