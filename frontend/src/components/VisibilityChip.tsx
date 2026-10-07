import { Globe, Lock, LockOpen, PencilLine, UserPen, type LucideIcon } from 'lucide-react';
import type { EventVisibilityState } from '../types';

export const VISIBILITY_META: Record<EventVisibilityState, { label: string; description: string; Icon: LucideIcon; cls: string }> = {
    public: { label: 'Public', description: 'Everyone', Icon: Globe, cls: 'text-success' },
    private: { label: 'Private', description: 'Only its owner — not in discovery, feeds or notifications', Icon: Lock, cls: 'text-action' },
};

export const PUBLIC_REQUEST_HINT = 'Owner asked to make it public';

/** Admin event flags shown as icons in grids and filter pills. */
export const ADMIN_FLAG_META: Record<string, { label: string; Icon: LucideIcon; cls: string }> = {
    submitted: { label: 'Submitted by a user', Icon: UserPen, cls: 'text-ink-soft' },
    wants_public: { label: PUBLIC_REQUEST_HINT, Icon: LockOpen, cls: 'text-amber-600' },
    changes: { label: 'Pending changes', Icon: PencilLine, cls: 'text-orange-600' },
    public: { label: 'Public', Icon: Globe, cls: 'text-success' },
    private: { label: 'Private', Icon: Lock, cls: 'text-action' },
};

export function FlagIcon({ flag, size = 14 }: { flag: string; size?: number }) {
    const meta = ADMIN_FLAG_META[flag];
    if (!meta) return null;
    return (
        <span title={meta.label} aria-label={meta.label} role="img" className={`inline-flex shrink-0 items-center ${meta.cls}`}>
            <meta.Icon size={size} aria-hidden="true" />
        </span>
    );
}

export function WantsPublicChip() {
    return (
        <span
            data-testid="wants-public-chip"
            title={PUBLIC_REQUEST_HINT}
            aria-label={PUBLIC_REQUEST_HINT}
            role="img"
            className="inline-flex shrink-0 items-center text-amber-600"
        >
            <LockOpen size={14} aria-hidden="true" />
        </span>
    );
}

export default function VisibilityChip({ state, title }: { state: EventVisibilityState; title?: string }) {
    const { label, description, Icon, cls } = VISIBILITY_META[state];
    return (
        <span
            data-testid="visibility-chip"
            title={title ?? `${label}: ${description}`}
            aria-label={label}
            role="img"
            className={`inline-flex shrink-0 items-center ${cls}`}
        >
            <Icon size={14} aria-hidden="true" />
        </span>
    );
}
