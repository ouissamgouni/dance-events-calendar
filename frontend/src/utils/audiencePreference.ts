/**
 * Last-used per-event audience hint (Phase C).
 *
 * Stores the most recent explicit audience choice a user made for *any*
 * per-event interaction (Save or RSVP). Used to pre-fill the audience
 * picker on subsequent events so users who, e.g., always share with
 * "friends" don't have to re-toggle every time.
 *
 * Scope: per-user-identity localStorage. The legacy fallback (when no
 * hint stored) is "public" for signed-in users (the new default after
 * the visibility-simplification refactor).
 */

import type { ShareAudience } from '../api';

const KEY_PREFIX = 'audience.lastUsed.';

const VALID: ReadonlyArray<ShareAudience> = ['public', 'friends', 'private'];

function isAudience(value: unknown): value is ShareAudience {
    return typeof value === 'string' && (VALID as readonly string[]).includes(value);
}

function keyFor(identity: string | null | undefined): string | null {
    if (!identity) return null;
    return `${KEY_PREFIX}${identity}`;
}

/** Read the last-used audience for the given user identity. Returns
 *  ``null`` when no hint is recorded (caller should fall back to the
 *  signed-in default — ``"public"`` post-refactor). */
export function getLastUsedAudience(identity: string | null | undefined): ShareAudience | null {
    const k = keyFor(identity);
    if (!k) return null;
    try {
        const raw = window.localStorage.getItem(k);
        return isAudience(raw) ? raw : null;
    } catch {
        return null;
    }
}

/** Persist an explicit per-event audience choice as the new "last used"
 *  hint for the given identity. No-op when ``identity`` is falsy. */
export function setLastUsedAudience(
    identity: string | null | undefined,
    audience: ShareAudience,
): void {
    const k = keyFor(identity);
    if (!k) return;
    try {
        window.localStorage.setItem(k, audience);
    } catch {
        /* swallow quota / disabled-storage errors */
    }
}

/** Default audience for a *new* per-event interaction (Save / RSVP).
 *  Anonymous viewers always get ``"private"`` (their data never leaves
 *  the device until they sign in). Signed-in users get the last-used
 *  hint, falling back to ``"public"``. */
export function defaultAudienceFor(
    identity: string | null | undefined,
): ShareAudience {
    if (!identity) return 'private';
    return getLastUsedAudience(identity) ?? 'public';
}
