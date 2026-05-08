interface Props {
    distribution: Record<number, number>;
    total: number;
    onFilterStars?: (stars: number | null) => void;
    activeStars?: number | null;
}

export default function RatingDistribution({ distribution, total, onFilterStars, activeStars }: Props) {
    return (
        <div className="space-y-1">
            {[5, 4, 3, 2, 1].map((stars) => {
                const count = distribution[stars] ?? 0;
                const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                const active = activeStars === stars;
                const clickable = !!onFilterStars;
                const Component = clickable ? 'button' : 'div';
                return (
                    <Component
                        key={stars}
                        type={clickable ? 'button' : undefined}
                        onClick={clickable ? () => onFilterStars?.(active ? null : stars) : undefined}
                        className={`w-full flex items-center gap-2 text-xs ${clickable ? 'hover:bg-slate-50 rounded px-1 py-0.5 transition' : ''} ${active ? 'bg-amber-50' : ''}`.trim()}
                        aria-label={clickable ? `Filter by ${stars}-star reviews` : undefined}
                    >
                        <span className="w-6 text-right text-slate-600">{stars}★</span>
                        <div className="flex-1 h-2 bg-slate-100 rounded overflow-hidden">
                            <div className="h-full bg-amber-400 transition-all" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="w-10 text-right text-slate-500 tabular-nums">{count}</span>
                    </Component>
                );
            })}
        </div>
    );
}
