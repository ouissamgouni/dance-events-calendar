import { firstNameOf } from '../utils/displayName';

export interface PersonMini {
    handle: string;
    display_name?: string | null;
    avatar_url?: string | null;
}

interface Props {
    people: PersonMini[];
    /** Total selected count; drives the "+N" overflow. Defaults to people.length. */
    total?: number;
    /** Faces to show before collapsing into "+N". Defaults to 3. */
    max?: number;
    /** Visual density. `sm` (default) suits the summary bar; `md` the filter sheet. */
    size?: 'sm' | 'md';
    className?: string;
}

const SIZE: Record<'sm' | 'md', { avatar: string; initial: string; overlap: string }> = {
    sm: { avatar: 'h-5 w-5', initial: 'text-[9px]', overlap: '-ml-1.5' },
    md: { avatar: 'h-7 w-7', initial: 'text-[10px]', overlap: '-ml-2.5' },
};

/** Overlapping avatar track for an arbitrary set of selected people (up to
 * ``max`` faces, then "+N"). Reused by the filter summary bar's people chip
 * and the filter sheet's people row. */
export default function PeopleAvatarTrack({ people, total, max = 3, size = 'sm', className }: Props) {
    if (people.length === 0) return null;
    const styles = SIZE[size];
    const faces = people.slice(0, max);
    const overflow = Math.max(0, (total ?? people.length) - faces.length);
    const ring = 'border-2 border-surface';
    return (
        <span className={`flex shrink-0 items-center ${className ?? ''}`.trim()}>
            {faces.map((p, i) => {
                const label = firstNameOf(p.display_name, p.handle);
                return p.avatar_url ? (
                    <img
                        key={p.handle}
                        src={p.avatar_url}
                        alt=""
                        loading="lazy"
                        className={`${styles.avatar} rounded-full object-cover ${ring}${i ? ` ${styles.overlap}` : ''}`}
                        referrerPolicy="no-referrer"
                    />
                ) : (
                    <span
                        key={p.handle}
                        className={`${styles.avatar} inline-flex items-center justify-center rounded-full bg-slate-200 ${styles.initial} font-semibold text-ink-soft ${ring}${i ? ` ${styles.overlap}` : ''}`}
                    >
                        {label.replace(/^@/, '').slice(0, 1).toUpperCase()}
                    </span>
                );
            })}
            {overflow > 0 && (
                <span
                    className={`${styles.avatar} ${styles.overlap} inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-slate-100 ${styles.initial} font-semibold text-ink-soft ${ring}`}
                >
                    +{overflow}
                </span>
            )}
        </span>
    );
}
