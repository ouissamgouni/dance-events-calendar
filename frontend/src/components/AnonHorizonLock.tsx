import { Lock } from 'lucide-react';
import { useSignIn } from '../context/SignInSheetContext';
import { formatHorizonDate } from '../utils/anonHorizon';

interface Props {
    lockedCount: number;
    horizonEnd: Date;
    variant?: 'card' | 'chip';
    className?: string;
    'data-testid'?: string;
}

/** Sign-in prompt for events past the signed-out browsing horizon. */
export default function AnonHorizonLock({ lockedCount, horizonEnd, variant = 'card', className = '', 'data-testid': testId }: Props) {
    const openSignIn = useSignIn();
    const date = formatHorizonDate(horizonEnd);
    const noun = lockedCount === 1 ? 'event' : 'events';

    if (variant === 'chip') {
        return (
            <button
                type="button"
                onClick={() => openSignIn('explore')}
                className={`inline-flex items-center gap-1.5 border border-blue-100 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink shadow-sm transition hover:bg-canvas ${className}`}
                data-testid={testId ?? 'anon-horizon-lock-chip'}
            >
                <Lock className="h-3.5 w-3.5 text-action" aria-hidden="true" />
                <span>{lockedCount} more {noun} after {date}</span>
                <span className="font-semibold text-action">Sign in</span>
            </button>
        );
    }

    return (
        <div className={`border border-blue-100 bg-blue-50 p-4 ${className}`} data-testid={testId ?? 'anon-horizon-lock'}>
            <p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-action">
                <Lock className="h-3 w-3" aria-hidden="true" />
                More events available
            </p>
            <p className="mt-1 text-sm font-medium text-ink">
                Sign in to unlock {lockedCount} more {noun} after {date}.
            </p>
            <p className="mt-1 text-xs text-ink-soft">
                Signed-out visitors see events up to {date}. A free account shows everything ahead.
            </p>
            <button
                type="button"
                onClick={() => openSignIn('explore')}
                className="mt-3 inline-flex items-center justify-center bg-action px-3 py-2 text-xs font-semibold text-white transition hover:opacity-90"
            >
                Sign in to see more
            </button>
        </div>
    );
}
