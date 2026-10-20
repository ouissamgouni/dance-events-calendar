import { useEffect } from 'react';
import { trackShare } from '../api';
import { getDeviceId } from '../utils/deviceId';

const STORAGE_KEY = 'movida_referral_src';
// Attribution window: a click counts as a referral source for one week.
// Long enough to cover "saw a link Friday, RSVP'd Sunday for next weekend",
// short enough that stale attributions don't pile up indefinitely.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredReferral {
    src: string;
    eventId: string;
    capturedAt: number;
    /** Sharer's invite code when the link was a friend invite. */
    inv?: string;
}

const INVITE_CODE_RE = /^[A-Za-z0-9_-]{4,32}$/;

/** Persist the referral source from a `?ref=share&src=` URL into
 *  localStorage so subsequent in-session conversions can be attributed
 *  back to the originating share_code. */
function persist(src: string, eventId: string, inv?: string): void {
    try {
        const payload: StoredReferral = {
            src,
            eventId,
            capturedAt: Date.now(),
            ...(inv ? { inv } : {}),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
        /* storage may be unavailable (private mode, quota); silently degrade */
    }
}

function read(): StoredReferral | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as StoredReferral;
        if (
            !parsed ||
            typeof parsed.src !== 'string' ||
            typeof parsed.capturedAt !== 'number'
        ) {
            return null;
        }
        if (Date.now() - parsed.capturedAt > TTL_MS) {
            localStorage.removeItem(STORAGE_KEY);
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

/** Read the currently-active referral, if any. Returns null when expired
 *  or absent. Safe to call at any render frequency. */
export function getActiveReferral(): StoredReferral | null {
    return read();
}

/** Capture `?ref=share&src={share_code}` from the current URL on mount,
 *  fire a server-side `click` ping, and stash the source for later
 *  attribution. Idempotent within an event/source pair. */
export function useReferralAttribution(eventId: string | null | undefined): void {
    useEffect(() => {
        if (!eventId) return;
        if (typeof window === 'undefined') return;
        const params = new URLSearchParams(window.location.search);
        if (params.get('ref') !== 'share') return;
        const src = params.get('src');
        if (!src) return;
        const rawInv = params.get('inv');
        const inv = rawInv && INVITE_CODE_RE.test(rawInv) ? rawInv : undefined;

        // Skip if we've already attributed this exact share for this event
        // in the current TTL window (defensive against double mounts and
        // back/forward navigation).
        const existing = read();
        const sameShare = !!existing && existing.src === src && existing.eventId === eventId;
        if (sameShare && (!inv || existing?.inv === inv)) {
            return;
        }

        persist(src, eventId, inv);
        // Notify in-app listeners (e.g. ShareReferralBanner mounted at the
        // App level, whose own effect already ran with an empty store
        // before this route child's effect persisted the attribution).
        try {
            window.dispatchEvent(new CustomEvent('referral:changed'));
        } catch { /* ignore */ }
        if (sameShare) return;
        // Best-effort; failures are silent (analytics, not functional state).
        trackShare({
            eventId,
            action: 'click',
            shareCode: src,
            deviceId: getDeviceId(),
        }).catch(() => { /* ignore */ });
    }, [eventId]);
}
