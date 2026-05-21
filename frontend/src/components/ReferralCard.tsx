/**
 * Phase E (E7) — referral card on the account screen.
 *
 * Lazy-loads the viewer's referral code (idempotent — backend reuses
 * any existing row), renders a copy-to-clipboard link and an optional
 * native share trigger, plus invite stats.
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchMyReferral, type ReferralResponse } from '../api';

export default function ReferralCard() {
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

    return (
        <section className="border border-slate-200 bg-white p-6 mb-4">
            <h2 className="text-base font-semibold text-slate-900 mb-1">
                Invite friends
            </h2>
            <p className="text-xs text-slate-600 mb-3">
                Anyone who joins with your link becomes mutual friends with you.
            </p>
            {error && (
                <div className="mb-3 border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                    {error}
                </div>
            )}
            {data === null && !error ? (
                <p className="text-sm text-slate-400">Loading…</p>
            ) : data ? (
                <>
                    <div className="flex items-center gap-2">
                        <input
                            type="text"
                            readOnly
                            value={data.url}
                            onFocus={(e) => e.currentTarget.select()}
                            aria-label="Referral URL"
                            className="flex-1 border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700"
                        />
                        <button
                            type="button"
                            onClick={() => void copy()}
                            className="border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                            {copied ? 'Copied!' : 'Copy'}
                        </button>
                        <button
                            type="button"
                            onClick={() => void share()}
                            className="bg-blue-500 px-3 py-1 text-xs font-medium text-white hover:bg-blue-600"
                        >
                            Share
                        </button>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                        {data.used_count === 0
                            ? 'No one has used your link yet.'
                            : `${data.used_count} ${data.used_count === 1 ? 'person has' : 'people have'} joined via your link.`}
                    </p>
                </>
            ) : null}
        </section>
    );
}
