/**
 * Name-display helpers shared across the header, the people filter, and the
 * network snapshot so the "how do we shorten a person's name" rule lives in
 * one place.
 */

/**
 * First token of a display name (before the first space). Falls back to
 * ``@handle`` when there's no display name, then to an empty string.
 */
export function firstNameOf(displayName?: string | null, handle?: string | null): string {
    const dn = (displayName || '').trim();
    if (dn) return dn.split(/\s+/)[0];
    return handle ? `@${handle}` : '';
}

/** First ``max`` names joined by ", ", then "+N" for the rest: "Alice, Bob, Carla +2". */
export function formatNameList(names: string[], max: number): string {
    const shown = names.slice(0, max).join(', ');
    const extra = names.length - max;
    return extra > 0 ? `${shown} +${extra}` : shown;
}
