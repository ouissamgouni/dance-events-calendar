import { useEffect, useId, useRef, useState, type FocusEvent } from 'react';
import { X } from 'lucide-react';
import useBackToClose from '../../hooks/useBackToClose';
import AuthPanel from './AuthPanel';
import { SIGN_IN_INTENT_COPY, type SignInIntent } from './signInIntent';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';
// Below this the visual viewport shrink is browser chrome, not a keyboard.
const KEYBOARD_MIN_PX = 80;

interface Props {
    intent: SignInIntent;
    onClose: () => void;
}

/** Contextual sign-in: bottom sheet on mobile, centred dialog from ``sm`` up. */
export default function AuthSheet({ intent, onClose }: Props) {
    const panelRef = useRef<HTMLDivElement>(null);
    const uid = useId();
    const headingId = `${uid}-heading`;
    const subtitleId = `${uid}-subtitle`;
    const copy = SIGN_IN_INTENT_COPY[intent];
    const [viewport, setViewport] = useState<{ height: number; keyboard: number } | null>(null);
    useBackToClose(onClose);

    useEffect(() => {
        const panel = panelRef.current;
        panel?.focus();
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        const focusables = () =>
            [...(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => !el.closest('.hidden'));

        // Capture phase so an underlying modal's Escape/Tab handlers never see these keys.
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
                return;
            }
            if (e.key !== 'Tab' || !panel) return;
            const items = focusables();
            if (items.length === 0) {
                e.preventDefault();
                return;
            }
            const first = items[0];
            const last = items[items.length - 1];
            const active = document.activeElement;
            if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
                e.preventDefault();
                first.focus();
            }
        };
        const onFocusIn = (e: globalThis.FocusEvent) => {
            if (panel && e.target instanceof Node && !panel.contains(e.target)) panel.focus();
        };
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('focusin', onFocusIn);
        return () => {
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('focusin', onFocusIn);
            document.body.style.overflow = previousOverflow;
        };
    }, [onClose]);

    // Keep the sheet above the on-screen keyboard and within the visible area.
    useEffect(() => {
        const vv = window.visualViewport;
        if (!vv) return;
        const update = () => {
            const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
            setViewport({ height: vv.height, keyboard: covered > KEYBOARD_MIN_PX ? covered : 0 });
        };
        update();
        vv.addEventListener('resize', update);
        vv.addEventListener('scroll', update);
        return () => {
            vv.removeEventListener('resize', update);
            vv.removeEventListener('scroll', update);
        };
    }, []);

    const handleFocus = (e: FocusEvent<HTMLDivElement>) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement)) return;
        // Wait for the keyboard animation before revealing the field.
        window.setTimeout(() => target.scrollIntoView?.({ block: 'nearest' }), 300);
    };

    return (
        <div
            className="fixed inset-0 z-[12000] flex items-end justify-center bg-slate-900/50 animate-fade-in sm:items-center sm:p-4"
            style={viewport?.keyboard ? { paddingBottom: viewport.keyboard } : undefined}
            onClick={onClose}
        >
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={headingId}
                aria-describedby={subtitleId}
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
                onFocus={handleFocus}
                style={viewport ? { maxHeight: viewport.height - 16 } : undefined}
                className="max-h-[calc(100dvh-16px)] w-full max-w-[440px] overflow-y-auto overscroll-contain rounded-t-sheet bg-surface px-6 pt-2 pb-[calc(24px+env(safe-area-inset-bottom))] shadow-2xl outline-none animate-slide-up sm:rounded-sheet sm:pt-5 sm:pb-6"
            >
                <div className="flex justify-center pb-2 sm:hidden" aria-hidden="true">
                    {/* eslint-disable-next-line no-restricted-syntax -- drag handle is a pill by design */}
                    <span className="h-1.5 w-11 rounded-full bg-auth-border" />
                </div>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <img src="/movida.png" alt="" aria-hidden="true" className="h-8 w-8 object-contain" />
                        <span className="text-xl font-bold leading-none tracking-tight text-auth-navy">Movida</span>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="-mr-2 flex h-11 w-11 items-center justify-center text-auth-navy transition hover:bg-canvas focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-action/35"
                    >
                        <X aria-hidden className="h-6 w-6" strokeWidth={1.8} />
                    </button>
                </div>
                <div className="mt-4">
                    <AuthPanel
                        variant="sheet"
                        headline={copy.headline}
                        subtitle={copy.subtitle}
                        headingId={headingId}
                        subtitleId={subtitleId}
                        onKeepBrowsing={onClose}
                    />
                </div>
            </div>
        </div>
    );
}
