interface ReachHiddenHintProps {
    count: number;
    /** `map` renders a compact floating pill scoped to the current map view. */
    variant?: 'banner' | 'map';
    onShow: () => void;
    onDismiss?: () => void;
    className?: string;
    style?: React.CSSProperties;
}

export default function ReachHiddenHint({ count, variant = 'banner', onShow, onDismiss, className = '', style }: ReachHiddenHintProps) {
    if (count <= 0) return null;
    const noun = count === 1 ? 'local event' : 'local events';
    const dismissButton = onDismiss && (
        <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 inline-flex h-6 w-6 items-center justify-center text-muted hover:text-ink"
            data-testid="reach-hidden-hint-dismiss"
        >
            ×
        </button>
    );

    if (variant === 'map') {
        return (
            <div
                className={`inline-flex items-center gap-2 border border-blue-100 bg-blue-50 pl-3 pr-1 py-1 text-xs text-ink shadow-md whitespace-nowrap ${className}`}
                style={style}
                role="status"
                data-testid="reach-hidden-hint-map"
            >
                <span>{count} {noun} hidden in this view</span>
                <button
                    type="button"
                    onClick={onShow}
                    className="font-semibold text-action hover:underline"
                    data-testid="reach-hidden-hint-show"
                >
                    Show
                </button>
                {dismissButton}
            </div>
        );
    }

    return (
        <div
            className={`flex items-center gap-2 border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-ink ${className}`}
            style={style}
            role="status"
            data-testid="reach-hidden-hint"
        >
            <img src="/scale.png" alt="" aria-hidden="true" className="h-4 w-4 shrink-0" />
            <p className="flex-1 min-w-0">
                <span className="font-semibold">{count} {noun}</span> hidden by your Event reach filter
            </p>
            <button
                type="button"
                onClick={onShow}
                className="shrink-0 bg-action text-white text-xs font-semibold px-3 py-1.5 hover:opacity-90"
                data-testid="reach-hidden-hint-show"
            >
                Show
            </button>
            {dismissButton}
        </div>
    );
}
