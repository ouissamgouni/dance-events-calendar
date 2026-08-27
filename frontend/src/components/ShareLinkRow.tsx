import { Copy, Share2, CheckCircle, AlertCircle } from 'lucide-react';
import { useState, useEffect } from 'react';

interface ShareLinkRowProps {
    url: string;
    onCopyClick?: () => Promise<void>;
    onShareClick?: () => Promise<void>;
    isBusy?: boolean;
    disabled?: boolean;
}

export default function ShareLinkRow({
    url,
    onCopyClick,
    onShareClick,
    isBusy,
    disabled,
}: ShareLinkRowProps) {
    const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');

    useEffect(() => {
        if (copyStatus !== 'idle') {
            const timeout = setTimeout(() => setCopyStatus('idle'), 2500);
            return () => clearTimeout(timeout);
        }
    }, [copyStatus]);

    const handleCopy = async () => {
        try {
            if (onCopyClick) {
                await onCopyClick();
            } else {
                await navigator.clipboard.writeText(url);
            }
            setCopyStatus('copied');
        } catch {
            setCopyStatus('error');
        }
    };

    const handleShare = async () => {
        try {
            if (onShareClick) {
                await onShareClick();
            } else if (typeof navigator !== 'undefined' && 'share' in navigator) {
                await (navigator as any).share({
                    title: 'My Movida Calendar',
                    url,
                });
            } else {
                await navigator.clipboard.writeText(url);
                setCopyStatus('copied');
            }
        } catch (error) {
            if ((error as DOMException)?.name !== 'AbortError') {
                setCopyStatus('error');
            }
        }
    };

    // Truncate long URLs for display
    const displayUrl = url.length > 60 ? url.substring(0, 57) + '...' : url;
    const showShareButton = typeof navigator !== 'undefined' && 'share' in navigator;

    return (
        <div className="flex items-center gap-2 px-3 py-3">
            <input
                type="text"
                readOnly
                value={displayUrl}
                className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-2 text-xs text-ink-soft cursor-default"
                title={url}
            />
            <button
                type="button"
                onClick={handleCopy}
                disabled={disabled || isBusy}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded bg-canvas hover:bg-surface disabled:opacity-50"
                aria-label="Copy link"
                title="Copy to clipboard"
            >
                {copyStatus === 'copied' ? (
                    <CheckCircle className="h-4 w-4 text-green-600" aria-hidden="true" />
                ) : copyStatus === 'error' ? (
                    <AlertCircle className="h-4 w-4 text-red-600" aria-hidden="true" />
                ) : (
                    <Copy className="h-4 w-4 text-ink" aria-hidden="true" />
                )}
            </button>
            {showShareButton && (
                <button
                    type="button"
                    onClick={handleShare}
                    disabled={disabled || isBusy}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded bg-canvas hover:bg-surface disabled:opacity-50"
                    aria-label="Share link"
                    title="Share using native share"
                >
                    <Share2 className="h-4 w-4 text-ink" aria-hidden="true" />
                </button>
            )}
        </div>
    );
}
