import { useMemo } from 'react';
import { useToast } from './Toast';
import { trackLink } from '../utils/tracking';

interface ShareButtonProps {
    eventId: string;
    title: string;
    url: string;
    className?: string;
}

/**
 * Adaptive share button:
 * - When the Web Share API is available (most mobile browsers), opens the
 *   native share sheet (which already includes WhatsApp, Messages, Mail, etc.).
 * - Otherwise (most desktops), copies the link to the clipboard and shows a toast.
 */
export default function ShareButton({ eventId, title, url, className }: ShareButtonProps) {
    const toast = useToast();
    const canNativeShare = useMemo(
        () => typeof navigator !== 'undefined' && typeof navigator.share === 'function',
        []
    );

    const handleClick = async () => {
        trackLink(eventId, url);
        if (canNativeShare) {
            try {
                await navigator.share({ title, text: title, url });
            } catch {
                // user cancelled or share failed; ignore
            }
            return;
        }
        try {
            await navigator.clipboard.writeText(url);
            toast.push({ title: 'Link copied', variant: 'success', duration: 2000 });
        } catch {
            toast.push({ title: 'Could not copy link', variant: 'error' });
        }
    };

    return (
        <button
            type="button"
            onClick={handleClick}
            aria-label={canNativeShare ? 'Share' : 'Copy link'}
            className={
                className ??
                'text-xs text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded px-2.5 py-1 transition shrink-0'
            }
        >
            {canNativeShare ? (
                <>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="inline h-3.5 w-3.5 align-[-2px] mr-1">
                        <path d="M13 4.5a2.5 2.5 0 1 1 .702 1.737L6.97 9.604a2.518 2.518 0 0 1 0 .792l6.733 3.367a2.5 2.5 0 1 1-.671 1.341l-6.733-3.367a2.5 2.5 0 1 1 0-3.475l6.733-3.367A2.52 2.52 0 0 1 13 4.5Z" />
                    </svg>
                    Share
                </>
            ) : (
                <>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="inline h-3.5 w-3.5 align-[-2px] mr-1">
                        <path fillRule="evenodd" d="M12.232 4.232a2.5 2.5 0 0 1 3.536 3.536l-1.225 1.224a.75.75 0 0 0 1.061 1.06l1.224-1.224a4 4 0 0 0-5.656-5.656l-3 3a4 4 0 0 0 .225 5.865.75.75 0 0 0 .977-1.138 2.5 2.5 0 0 1-.142-3.667l3-3Z" clipRule="evenodd" />
                        <path fillRule="evenodd" d="M11.603 7.963a.75.75 0 0 0-.977 1.138 2.5 2.5 0 0 1 .142 3.667l-3 3a2.5 2.5 0 0 1-3.536-3.536l1.225-1.224a.75.75 0 0 0-1.061-1.06l-1.224 1.224a4 4 0 1 0 5.656 5.656l3-3a4 4 0 0 0-.225-5.865Z" clipRule="evenodd" />
                    </svg>
                    Copy link
                </>
            )}
        </button>
    );
}
