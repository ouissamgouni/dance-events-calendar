import { Link } from 'react-router-dom';

interface Props {
    /** Section header, e.g. "Overall experience" or "Typical experience". */
    label: string;
    /** 'none' hides the box; 'early' shows "Early feedback"; 'full' shows the mood. */
    displayState: 'none' | 'early' | 'full';
    /** Mood emoji (from ``aspectMood(average).emoji``). */
    emoji: string;
    /** Public mood label ("Well received"); null below the review threshold. */
    moodLabel?: string | null;
    /** When true, render "Usually {mood}" (lower-cased) — used for pooled series. */
    usually?: boolean;
    /** Unrounded 0–100 "Great or Amazing" share. */
    positivePercentage: number;
    /** Provenance line, e.g. "Based on 12 reviews" or "Based on the last 8 editions". */
    subline: string;
    /** Optional in-box link (e.g. to the series page). */
    link?: { to: string; label: string };
}

/**
 * Shared "mood box" — a bordered summary of a community's overall experience
 * (label + mood headline + "X% rated it Great or Amazing" + provenance). Used
 * for both an event's own "Overall experience" and a series' pooled "Typical
 * experience", so the two read identically across the modal, map popup, and
 * detail page. Renders nothing when there is no feedback yet.
 */
export default function ExperienceMoodBox({
    label,
    displayState,
    emoji,
    moodLabel,
    usually = false,
    positivePercentage,
    subline,
    link,
}: Props) {
    if (displayState === 'none') return null;

    const positivePct = Math.round(positivePercentage ?? 0);

    return (
        <div className="border border-line bg-canvas px-3 py-2.5 space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
                {label}
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                {displayState === 'full' && moodLabel ? (
                    <span className="text-sm font-bold text-ink">
                        {emoji} {usually ? `Usually ${moodLabel.toLowerCase()}` : moodLabel}
                    </span>
                ) : (
                    <span className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
                        Early feedback
                    </span>
                )}
                <span className="text-xs text-ink-soft">
                    <span className="font-semibold text-ink tabular-nums">{positivePct}%</span> rated it Great or Amazing
                </span>
            </div>
            <div className="text-[11px] text-muted">{subline}</div>
            {link && (
                <Link
                    to={link.to}
                    className="inline-block text-[11px] font-medium text-sky-600 hover:text-sky-700"
                >
                    {link.label}
                </Link>
            )}
        </div>
    );
}
