import { useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSignIn } from '../context/SignInSheetContext';
import {
    fetchShareSource,
    redeemReferral,
    redeemShareFollow,
    type ShareSourceResponse,
} from '../api';
import {
    getSharePrompt,
    resolveSharePrompt,
    setSharePromptIntent,
} from '../hooks/useReferralAttribution';
import BottomSheet from './BottomSheet';
import { useToast } from './Toast';

/** Friend invites become mutual via the invite code; plain shares stay one-way. */
function redeem(shareCode: string, inviteCode: string | null): Promise<string | null> {
    return inviteCode
        ? redeemReferral(inviteCode, true).then((r) => r.inviter_handle)
        : redeemShareFollow(shareCode, true).then((r) => r.sharer_handle);
}

function isEventPage(pathname: string, eventId: string): boolean {
    const base = `/event/${eventId}`;
    return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * One-time invite sheet for visitors arriving on an event via a share link
 * (`?ref=share&src=<share_code>[&inv=<invite code>]`). Friend invites offer
 * mutual friendship; plain shares offer a one-way follow. The pending invite
 * lives in sessionStorage (see `useReferralAttribution`), so it belongs to the
 * tab that opened the link and is dropped on sign-out.
 */
export default function ShareReferralBanner() {
    const { user, loading: authLoading } = useAuth();
    const { pathname } = useLocation();
    const openSignIn = useSignIn();
    const toast = useToast();
    const [, refresh] = useReducer((n: number) => n + 1, 0);
    const [fetched, setFetched] = useState<{ key: string; source: ShareSourceResponse | null } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const redeemingRef = useRef(false);

    useEffect(() => {
        window.addEventListener('referral:changed', refresh);
        return () => window.removeEventListener('referral:changed', refresh);
    }, []);

    const prompt = getSharePrompt();
    const src = prompt?.src ?? null;
    const inv = prompt?.inv ?? null;
    // Re-resolve per viewer: the relationship fields depend on who is signed in.
    const key = src && !authLoading ? `${src}|${inv ?? ''}|${user?.user_id ?? ''}` : null;

    useEffect(() => {
        if (!key || !src) return;
        let cancelled = false;
        fetchShareSource(src, inv)
            .then((source) => { if (!cancelled) setFetched({ key, source }); })
            .catch(() => { if (!cancelled) setFetched({ key, source: null }); });
        return () => { cancelled = true; };
    }, [key, src, inv]);

    const source = fetched && fetched.key === key ? fetched.source : null;
    const friendInvite = !!source?.friend_invite && !!inv;
    const isSelf = !!user && !!src && user.share_code === src;
    const connected = !!source && (friendInvite ? !!source.viewer_is_friend : !!source.viewer_follows);
    const name = source?.display_name || (source?.handle ? `@${source.handle}` : null);

    const accept = () => {
        if (!src || !name || redeemingRef.current) return;
        redeemingRef.current = true;
        setBusy(true);
        setError(null);
        redeem(src, friendInvite ? inv : null)
            .then(() => {
                resolveSharePrompt();
                toast.push({
                    title: friendInvite ? `You and ${name} are now friends` : `You’re now following ${name}`,
                    variant: 'success',
                });
                window.dispatchEvent(new CustomEvent('network:changed'));
            })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => {
                redeemingRef.current = false;
                setBusy(false);
            });
    };

    // Nothing to offer: own link, or already connected to the sharer.
    const hasPrompt = !!prompt;
    useEffect(() => {
        if (hasPrompt && (isSelf || connected)) resolveSharePrompt();
    }, [hasPrompt, isSelf, connected]);

    // Guest chose "Sign up" earlier in this tab: accept as soon as they're signed in.
    const autoAccept = !!user && !!prompt?.intent && !!source && !isSelf && !connected;
    useEffect(() => {
        if (autoAccept) accept();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per readiness change
    }, [autoAccept]);

    if (!prompt || !source || !name || isSelf || connected) return null;
    if (prompt.intent || !isEventPage(pathname, prompt.eventId)) return null;

    const notNow = () => resolveSharePrompt();
    const primaryLabel = user
        ? friendInvite ? 'Become friends' : `Follow ${name}`
        : friendInvite ? 'Sign up to become friends' : 'Sign up to follow';
    const onPrimary = () => {
        if (user) {
            accept();
            return;
        }
        setSharePromptIntent();
        openSignIn('follow');
    };

    return createPortal(
        <div data-testid="share-referral-sheet">
            <BottomSheet
                title={friendInvite ? `${name} invited you` : `${name} shared this event`}
                variant="floating"
                compact
                desktop="modal"
                onClose={notNow}
                headerLeading={source.avatar_url ? (
                    // eslint-disable-next-line no-restricted-syntax -- profile avatars are circular by design
                    <img src={source.avatar_url} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
                ) : undefined}
            >
                <p className="text-sm leading-5 text-ink-soft">
                    {friendInvite
                        ? 'Become friends to see each other’s plans and go together.'
                        : 'Follow them to see where they’re dancing next.'}
                </p>
                {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
                <div className="mt-4 flex items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={notNow}
                        className="flex min-h-10 items-center justify-center rounded-field border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas"
                    >
                        Not now
                    </button>
                    <button
                        type="button"
                        onClick={onPrimary}
                        disabled={busy}
                        className="flex min-h-10 items-center justify-center rounded-field bg-action px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
                    >
                        {busy ? (friendInvite ? 'Connecting…' : 'Following…') : primaryLabel}
                    </button>
                </div>
            </BottomSheet>
        </div>,
        document.body,
    );
}
