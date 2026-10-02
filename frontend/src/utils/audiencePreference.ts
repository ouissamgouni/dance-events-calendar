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

interface RsvpAudienceUser {
    user_id?: string;
    share_attendance_default?: boolean;
    share_attendance_default_audience?: ShareAudience;
}

/** Going keeps the legacy unprefixed keys so existing choices carry over. */
export type AudienceKind = 'going' | 'saved';

const KEY_PREFIX = 'audience.lastUsed.';
const REMEMBER_KEY_PREFIX = 'audience.remember.';

function kindPrefix(base: string, kind: AudienceKind): string {
    return kind === 'saved' ? `${base}saved.` : base;
}

const VALID: ReadonlyArray<ShareAudience> = ['public', 'friends', 'private'];

function isAudience(value: unknown): value is ShareAudience {
    return typeof value === 'string' && (VALID as readonly string[]).includes(value);
}

function keyFor(identity: string | null | undefined, kind: AudienceKind): string | null {
    if (!identity) return null;
    return `${kindPrefix(KEY_PREFIX, kind)}${identity}`;
}

/** Read the last-used audience for the given user identity. Returns
 *  ``null`` when no hint is recorded (caller should fall back to the
 *  signed-in default — ``"public"`` post-refactor). */
export function getLastUsedAudience(
    identity: string | null | undefined,
    kind: AudienceKind = 'going',
): ShareAudience | null {
    const k = keyFor(identity, kind);
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
    kind: AudienceKind = 'going',
): void {
    const k = keyFor(identity, kind);
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

export function defaultRsvpAudienceFor(user: RsvpAudienceUser): ShareAudience {
    return user.share_attendance_default_audience
        ?? getLastUsedAudience(user.user_id)
        ?? (user.share_attendance_default === false ? 'private' : 'public');
}

/** Saves have no account-level default, so fall back to the RSVP one. */
export function defaultSavedAudienceFor(user: RsvpAudienceUser): ShareAudience {
    return getLastUsedAudience(user.user_id, 'saved') ?? defaultRsvpAudienceFor(user);
}

/** Whether the user ticked "Remember my choice"; ``null`` when never answered. */
export function getRememberAudience(
    identity: string | null | undefined,
    kind: AudienceKind = 'going',
): boolean | null {
    if (!identity) return null;
    try {
        const raw = window.localStorage.getItem(`${kindPrefix(REMEMBER_KEY_PREFIX, kind)}${identity}`);
        return raw === null ? null : raw === '1';
    } catch {
        return null;
    }
}

export function setRememberAudience(
    identity: string | null | undefined,
    remember: boolean,
    kind: AudienceKind = 'going',
): void {
    if (!identity) return;
    try {
        window.localStorage.setItem(`${kindPrefix(REMEMBER_KEY_PREFIX, kind)}${identity}`, remember ? '1' : '0');
    } catch {
        /* swallow quota / disabled-storage errors */
    }
}

export const AUDIENCE_TIER_LABELS: Record<ShareAudience, string> = {
    public: 'Public',
    friends: 'Friends',
    private: 'Private',
};
