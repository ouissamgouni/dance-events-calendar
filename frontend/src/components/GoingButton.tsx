import { useState, useCallback } from 'react';
import { useAttendingEvents } from '../context/AttendingEventsContext';

interface Props {
    eventId: string;
    appearance?: 'icon' | 'pill';
    size?: 'sm' | 'md';
    stopPropagation?: boolean;
    className?: string;
}

/** Heroicons hand-raised — outline when not going, solid when going */
function RaisedHandIcon({ solid, className }: { solid: boolean; className: string }) {
    if (solid) {
        return (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
                <path d="M10.5 1.875C10.5 1.25368 11.0037 0.75 11.625 0.75C12.2463 0.75 12.75 1.25368 12.75 1.875V10.0938C13.2674 10.2561 13.7708 10.4757 14.25 10.7527V3.375C14.25 2.75368 14.7537 2.25 15.375 2.25C15.9963 2.25 16.5 2.75368 16.5 3.375V14.3122C15.0821 14.5501 13.8891 15.451 13.2506 16.6852C14.4554 16.0866 15.8134 15.75 17.25 15.75C17.6642 15.75 18 15.4142 18 15V12.75L18 12.7336C18.0042 11.8771 18.3339 11.0181 18.9885 10.3635C19.4278 9.92417 20.1402 9.92417 20.5795 10.3635C21.0188 10.8028 21.0188 11.5152 20.5795 11.9545C20.361 12.173 20.2514 12.4567 20.25 12.7445L20.25 12.75L20.25 15.75H20.2454C20.1863 17.2558 19.5623 18.6877 18.4926 19.7574L16.7574 21.4926C15.6321 22.6179 14.106 23.25 12.5147 23.25H10.5C6.35786 23.25 3 19.8921 3 15.75V6.375C3 5.75368 3.50368 5.25 4.125 5.25C4.74632 5.25 5.25 5.75368 5.25 6.375V11.8939C5.71078 11.4421 6.2154 11.0617 6.75 10.7527V3.375C6.75 2.75368 7.25368 2.25 7.875 2.25C8.49632 2.25 9 2.75368 9 3.375V9.90069C9.49455 9.80023 9.99728 9.75 10.5 9.75V1.875Z" />
            </svg>
        );
    }
    return (
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor" className={className}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.05 4.575a1.575 1.575 0 1 0-3.15 0v3m3.15-3v-1.5a1.575 1.575 0 0 1 3.15 0v1.5m-3.15 0 .075 5.925m3.075.75V4.575m0 0a1.575 1.575 0 0 1 3.15 0V15M6.9 7.575a1.575 1.575 0 1 0-3.15 0v8.175a6.75 6.75 0 0 0 6.75 6.75h2.018a5.25 5.25 0 0 0 3.712-1.538l1.732-1.732a5.25 5.25 0 0 0 1.538-3.712l.003-2.024a.668.668 0 0 1 .198-.471 1.575 1.575 0 1 0-2.228-2.228 3.818 3.818 0 0 0-1.12 2.687M6.9 7.575V12m6.27 4.318A4.49 4.49 0 0 1 16.35 15m0 0a4.49 4.49 0 0 1 .437-1.997" />
        </svg>
    );
}

export default function GoingButton({
    eventId,
    appearance = 'icon',
    size = 'md',
    stopPropagation = false,
    className = '',
}: Props) {
    const { isAttending, toggleAttending } = useAttendingEvents();
    const going = isAttending(eventId);

    const [toastVisible, setToastVisible] = useState(false);
    const [toastFading, setToastFading] = useState(false);

    const triggerToast = useCallback(() => {
        setToastVisible(true);
        setToastFading(false);
        const fade = setTimeout(() => setToastFading(true), 700);
        const hide = setTimeout(() => { setToastVisible(false); setToastFading(false); }, 1300);
        return () => { clearTimeout(fade); clearTimeout(hide); };
    }, []);

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        if (stopPropagation) e.stopPropagation();
        toggleAttending(eventId);
        if (!going) triggerToast();
    };

    const iconSizeClass = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5';
    const tooltip = going ? 'Not going' : "I'm going";

    if (appearance === 'pill') {
        return (
            <button
                onClick={handleClick}
                title={tooltip}
                aria-label={tooltip}
                className={`text-xs rounded-full px-3 py-1 transition flex items-center gap-1.5 ${going ? 'text-emerald-800 bg-emerald-100 hover:bg-emerald-200' : 'text-slate-600 bg-slate-100 hover:bg-slate-200'} ${className}`.trim()}
            >
                <RaisedHandIcon solid={going} className="w-3.5 h-3.5" />
                {going ? 'Going ✓' : "I'm going"}
            </button>
        );
    }

    // Icon-only: CSS tooltip on desktop (pointer:fine), fade toast on mobile
    return (
        <div className="relative inline-flex items-center justify-center">
            <button
                onClick={handleClick}
                aria-label={tooltip}
                className={`group relative rounded-full transition-colors ${size === 'sm' ? 'p-0.5' : 'p-1.5'} ${going ? 'text-emerald-500 hover:text-emerald-700' : 'text-slate-400 hover:text-slate-600'} ${className}`.trim()}
            >
                {/* Desktop-only tooltip — fires only on fine pointer (mouse), never on touch */}
                <span
                    className="[@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 whitespace-nowrap rounded bg-slate-800 px-2 py-0.5 text-[10px] leading-tight text-white opacity-0 transition-opacity duration-150 delay-150"
                    aria-hidden
                >
                    {tooltip}
                    <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800" aria-hidden />
                </span>

                <RaisedHandIcon solid={going} className={iconSizeClass} />
            </button>

            {/* Fade-out "I'm going!" label below the button (desktop + mobile) */}
            {toastVisible && (
                <span
                    className={`pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1 whitespace-nowrap text-[10px] font-semibold text-emerald-600 transition-opacity duration-500 ${toastFading ? 'opacity-0' : 'opacity-100'}`}
                    aria-hidden
                >
                    I'm going!
                </span>
            )}
        </div>
    );
}
