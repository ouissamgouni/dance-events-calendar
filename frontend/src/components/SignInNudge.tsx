import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import useBackToClose from '../hooks/useBackToClose';
import { createPortal } from 'react-dom';
import { useAuth } from '../context/AuthContext';
import { useSignIn } from '../context/SignInSheetContext';

type Trigger = 'going' | 'save';

// Unified, persistent sign-in nudge gate.
// - Shows at most once per browser session.
// - After a dismissal, suppresses for COOLDOWN_MS.
// - After SUPPRESS_AFTER_DISMISSALS consecutive dismissals, suppresses
//   permanently until the user signs in (or clears storage).
const STORAGE_KEY = 'movida_signin_nudge';
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SUPPRESS_AFTER_DISMISSALS = 2;

interface NudgeState {
    dismissedAt?: number;
    dismissCount?: number;
    suppressed?: boolean;
}

let sessionShown = false;

function readState(): NudgeState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? (JSON.parse(raw) as NudgeState) : {};
    } catch {
        return {};
    }
}

function writeState(s: NudgeState) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
        // ignore
    }
}

function clearState() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // ignore
    }
}

/**
 * Hook gating whether a sign-in nudge should appear. Returns no-op state
 * when the user is signed in. Trigger drives copy only; gating is unified
 * across all triggers (we don't want to nag once per action).
 */
export function useSignInNudge(_trigger: Trigger) {
    const { user } = useAuth();
    const [, force] = useState(0);

    // Reset persisted state when user signs in so a future logout starts fresh.
    useEffect(() => {
        if (user) {
            const s = readState();
            if (s.dismissedAt || s.dismissCount || s.suppressed) {
                clearState();
            }
        }
    }, [user]);

    let shouldShow = false;
    if (!user && !sessionShown) {
        const s = readState();
        if (!s.suppressed && (!s.dismissedAt || Date.now() - s.dismissedAt >= COOLDOWN_MS)) {
            shouldShow = true;
        }
    }

    const markShown = useCallback(() => {
        sessionShown = true;
        force((n) => n + 1);
    }, []);

    const dismiss = useCallback(() => {
        sessionShown = true;
        const s = readState();
        const count = (s.dismissCount ?? 0) + 1;
        writeState({
            dismissedAt: Date.now(),
            dismissCount: count,
            suppressed: count >= SUPPRESS_AFTER_DISMISSALS,
        });
        force((n) => n + 1);
    }, []);

    return { shouldShow, markShown, dismiss };
}

interface PopoverPos { top: number; left: number; }

const POPOVER_WIDTH = 280;

function computePopoverPos(trigger: HTMLElement, popoverWidth: number): PopoverPos {
    const r = trigger.getBoundingClientRect();
    const margin = 8;
    const desiredLeft = r.left + r.width / 2 - popoverWidth / 2;
    const maxLeft = window.innerWidth - popoverWidth - margin;
    const left = Math.max(margin, Math.min(desiredLeft, maxLeft));
    return { top: r.bottom + 6, left };
}

interface Props {
    anchorRef: RefObject<HTMLElement | null>;
    trigger: Trigger;
    onClose: () => void;
}

const HEADLINE: Record<Trigger, string> = {
    going: 'Tell your friends you’re going',
    save: 'Keep this event saved',
};

/**
 * Portal-rendered popover that anchors below the trigger element. Closes on
 * outside click or Escape.
 */
export default function SignInNudge({ anchorRef, trigger, onClose }: Props) {
    const openSignIn = useSignIn();
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const [pos, setPos] = useState<PopoverPos | null>(null);
    useBackToClose(onClose);

    // Position under the anchor and keep it positioned on scroll/resize.
    useEffect(() => {
        const el = anchorRef.current;
        if (!el) return;
        const update = () => {
            if (anchorRef.current) {
                setPos(computePopoverPos(anchorRef.current, POPOVER_WIDTH));
            }
        };
        update();
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
        };
    }, [anchorRef]);

    // Outside click + Escape close.
    useEffect(() => {
        const onDocClick = (e: MouseEvent) => {
            const t = e.target as Node;
            if (popoverRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
            onClose();
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [anchorRef, onClose]);

    if (!pos) return null;

    return createPortal(
        <div
            ref={popoverRef}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Sign in suggestion"
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
            className="z-[12000] border border-line bg-surface p-3 shadow-xl text-left"
        >
            <p className="text-xs font-semibold text-ink">{HEADLINE[trigger]}</p>
            <p className="mt-0.5 text-xs text-ink-soft">It’s only on this device for now. With a free account you can:</p>
            <ul className="mt-1.5 space-y-0.5 text-xs text-ink-soft list-disc pl-4">
                <li>Keep saves and plans on every device</li>
                <li>See which friends are going</li>
                <li>Get reminders before events</li>
                <li>Rate events and join discussions</li>
            </ul>
            <div className="mt-3 flex justify-end gap-2">
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onClose(); }}
                    className="min-h-9 px-3 text-sm text-ink-soft hover:bg-canvas"
                >
                    Not now
                </button>
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onClose(); openSignIn(trigger); }}
                    className="min-h-9 px-3 text-sm bg-action text-white hover:opacity-90"
                >
                    Sign in
                </button>
            </div>
        </div>,
        document.body,
    );
}
