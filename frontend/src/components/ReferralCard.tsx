/**
 * Phase E (E7) — referral card on the account screen.
 *
 * Lazy-loads the viewer's referral code (idempotent — backend reuses
 * any existing row), renders a copy-to-clipboard link and an optional
 * native share trigger, plus invite stats.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { fetchMyReferral, type ReferralResponse } from '../api';

type ReferralCardProps = {
    /** Renders a shrunk-down version (title, description, stat and a
     * single button linking to the dedicated `/invite` page) instead of
     * the full URL/Copy/Share/QR UI. Used on the account settings page. */
    compact?: boolean;
};

export default function ReferralCard({ compact = false }: ReferralCardProps) {
    const [data, setData] = useState<ReferralResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetchMyReferral()
            .then((r) => { if (!cancelled) setData(r); })
            .catch((e: unknown) => {
                if (!cancelled) setError(e instanceof Error ? e.message : String(e));
            });
        return () => { cancelled = true; };
    }, []);

    const copy = useCallback(async () => {
        if (!data) return;
        try {
            await navigator.clipboard.writeText(data.url);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
        } catch {
            // Clipboard API unavailable (e.g. insecure context); ignore.
        }
    }, [data]);

    const share = useCallback(async () => {
        if (!data) return;
        if (typeof navigator.share !== 'function') {
            await copy();
            return;
        }
        try {
            await navigator.share({
                title: 'Join me on Movida',
                text: "I'm using Movida for salsa events — come follow me.",
                url: data.url,
            });
        } catch {
            // User dismissed share sheet; not an error.
        }
    }, [data, copy]);

    const statLine = data && (
        data.used_count === 0
            ? 'No one has used your link yet.'
            : `${data.used_count} ${data.used_count === 1 ? 'person has' : 'people have'} joined via your link.`
    );

    if (compact) {
        return (
            <section className="border border-line bg-surface p-6 mb-4">
                <h2 className="text-base font-semibold text-ink mb-1">
                    Invite friends
                </h2>
                <p className="text-xs text-ink-soft mb-3">
                    Anyone who joins with your link becomes mutual friends with you.
                </p>
                {error && (
                    <div className="mb-3 border border-line bg-canvas px-3 py-2 text-xs text-ink">
                        {error}
                    </div>
                )}
                {statLine && <p className="mb-3 text-xs text-ink-soft">{statLine}</p>}
                <Link
                    to="/invite"
                    className="inline-block bg-action px-4 py-2 text-xs font-medium text-white hover:bg-action"
                >
                    Invite a friend
                </Link>
            </section>
        );
    }

    return (
        <section className="border border-line bg-surface p-6 mb-4">
            <h2 className="text-base font-semibold text-ink mb-1">
                Invite friends
            </h2>
            <p className="text-xs text-ink-soft mb-3">
                Anyone who joins with your link becomes mutual friends with you.
            </p>
            {error && (
                <div className="mb-3 border border-line bg-canvas px-3 py-2 text-xs text-ink">
                    {error}
                </div>
            )}
            {data === null && !error ? (
                <p className="text-sm text-muted">Loading…</p>
            ) : data ? (
                <>
                    <div className="mb-4 flex justify-center">
                        <div className="border border-line p-3">
                            <QRCodeSVG value={data.url} size={200} />
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <input
                            type="text"
                            readOnly
                            value={data.url}
                            onFocus={(e) => e.currentTarget.select()}
                            aria-label="Referral URL"
                            className="flex-1 border border-line bg-canvas px-2 py-1 text-xs text-ink"
                        />
                        <button
                            type="button"
                            onClick={() => void copy()}
                            className="border border-line bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-canvas"
                        >
                            {copied ? 'Copied!' : 'Copy'}
                        </button>
                        <button
                            type="button"
                            onClick={() => void share()}
                            className="bg-action px-3 py-1 text-xs font-medium text-white hover:bg-action"
                        >
                            Share
                        </button>
                    </div>
                    <p className="mt-2 text-xs text-ink-soft">{statLine}</p>
                </>
            ) : null}
        </section>
    );
}
