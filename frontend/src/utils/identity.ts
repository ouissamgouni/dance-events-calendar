/**
 * Identity helpers for per-identity client-side caches.
 *
 * The server is the single source of truth for saved/going state — it
 * dedupes by ``user_id`` (when authed) or by the httpOnly ``movida_aid``
 * cookie (anonymous). The frontend keeps a per-identity localStorage cache
 * purely for instant first paint.
 *
 * The cache discriminator returned here is a *client-side* key — the
 * httpOnly cookie is not readable by JS, so we use the localStorage
 * ``movida_device_id`` for the anonymous bucket. That value is rotated on
 * logout / account-delete (see ``rotateDeviceId``), so the next anonymous
 * session reads from a fresh empty cache rather than the previous user's
 * leftover bookmarks.
 */

import { getDeviceId } from './deviceId';
import type { AuthUser } from '../api';

export type IdentityKey = string;

/**
 * Stable per-identity discriminator for namespacing localStorage caches.
 * - Authed → ``user:<user_id>``
 * - Anonymous → ``anon:<movida_device_id>``
 */
export function identityKey(user: AuthUser | null | undefined): IdentityKey {
    if (user?.user_id) return `user:${user.user_id}`;
    return `anon:${getDeviceId()}`;
}
