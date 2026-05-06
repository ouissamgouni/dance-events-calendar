import { useRef, useState } from 'react';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useAuth } from '../context/AuthContext';
import { useAnchoredToast, SIGN_IN_TOAST_MESSAGE } from './AnchoredToast';
import SignInNudge, { useSignInNudge } from './SignInNudge';

interface Props {
    eventId: string;
    appearance?: 'icon' | 'pill';
    size?: 'sm' | 'md';
    stopPropagation?: boolean;
    className?: string;
}

export default function SaveEventButton({
    eventId,
    appearance = 'icon',
    size = 'md',
    stopPropagation = false,
    className = '',
}: Props) {
    const { isSaved, toggleSave } = useSavedEvents();
    const { user } = useAuth();
    const saved = isSaved(eventId);
    const iconSizeClass = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5';
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const toast = useAnchoredToast(buttonRef);
    const nudge = useSignInNudge('save');
    const [showNudge, setShowNudge] = useState(false);

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        if (stopPropagation) event.stopPropagation();
        const wasSaved = saved;
        toggleSave(eventId);
        if (wasSaved) {
            // Unsaving: dismiss any lingering toast.
            toast.hide();
            return;
        }
        if (!user && nudge.shouldShow) {
            // First anonymous save in this session: show the rich popover
            // with a Sign-in CTA. Subsequent saves fall through to the toast.
            nudge.markShown();
            setShowNudge(true);
            return;
        }
        toast.show(user ? 'Saved' : SIGN_IN_TOAST_MESSAGE, user ? 1400 : 2800);
    };

    const nudgeNode = showNudge && !user ? (
        <SignInNudge anchorRef={buttonRef} trigger="save" onClose={() => setShowNudge(false)} />
    ) : null;

    if (appearance === 'pill') {
        return (
            <span className="relative inline-flex">
                <button
                    ref={buttonRef}
                    onClick={handleClick}
                    className={`text-xs rounded-full px-3 py-1 transition flex items-center gap-1 ${saved ? 'text-slate-800 bg-slate-200 hover:bg-slate-300' : 'text-slate-600 bg-slate-100 hover:bg-slate-200'} ${className}`.trim()}
                    aria-label={saved ? 'Unsave event' : 'Save event'}
                >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
                    </svg>
                    {saved ? 'Saved' : 'Save'}
                </button>
                {toast.node}
                {nudgeNode}
            </span>
        );
    }

    return (
        <span className="relative inline-flex">
            <button
                ref={buttonRef}
                onClick={handleClick}
                className={`rounded-full transition ${size === 'sm' ? 'p-0.5' : 'p-1.5'} ${saved ? 'text-slate-700 hover:text-slate-900' : 'text-slate-300 hover:text-slate-500'} ${className}`.trim()}
                aria-label={saved ? 'Unsave event' : 'Save event'}
            >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={iconSizeClass}>
                    <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
                </svg>
            </button>
            {toast.node}
            {nudgeNode}
        </span>
    );
}
