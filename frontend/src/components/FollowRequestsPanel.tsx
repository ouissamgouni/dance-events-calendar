import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    approveFollowRequest,
    declineFollowRequest,
    fetchFollowRequests,
    type FollowRequestItem,
} from '../api';

/**
 * Phase E (E8): inbox of pending inbound follow-requests.
 *
 * Rendered above the tabs in {@link NetworkPanel}. When no pending
 * rows exist (the common case) the component returns ``null`` so it
 * adds no visual weight. Approve/Decline use the dedicated endpoints
 * and emit ``network:changed`` so the surrounding panel and follower
 * counts refresh.
 *
 * Surface contract:
 * - Only shown to authenticated users (the route 401s for anon).
 * - "Approve" promotes the row to ``status='approved'`` server-side,
 *   creates the implied calendar subscription for the requester, and
 *   fires a ``new_follower`` notification. If approving also produces
 *   mutuality, a ``new_friend`` notification fires for both sides.
 * - "Decline" silently removes the row and the inbox notification.
 *   The requester is NOT notified of the decline (per product spec).
 */
export default function FollowRequestsPanel() {
    const [items, setItems] = useState<FollowRequestItem[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const list = await fetchFollowRequests();
            setItems(list.items);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed');
        }
    }, []);

    useEffect(() => {
        void load();
        // Refresh after follow graph mutations elsewhere in the app.
        const h = () => void load();
        window.addEventListener('network:changed', h);
        return () => window.removeEventListener('network:changed', h);
    }, [load]);

    const onApprove = useCallback(
        async (handle: string) => {
            setBusy(handle);
            setError(null);
            try {
                await approveFollowRequest(handle);
                setItems((prev) => prev.filter((it) => it.handle !== handle));
                window.dispatchEvent(new Event('network:changed'));
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed');
            } finally {
                setBusy(null);
            }
        },
        [],
    );

    const onDecline = useCallback(
        async (handle: string) => {
            setBusy(handle);
            setError(null);
            try {
                await declineFollowRequest(handle);
                setItems((prev) => prev.filter((it) => it.handle !== handle));
                window.dispatchEvent(new Event('network:changed'));
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed');
            } finally {
                setBusy(null);
            }
        },
        [],
    );

    if (items.length === 0) return null;

    return (
        <section
            data-testid="follow-requests-panel"
            className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3"
        >
            <h3 className="text-sm font-semibold text-amber-900 mb-2">
                Follow requests ({items.length})
            </h3>
            <ul className="space-y-2">
                {items.map((it) => (
                    <li
                        key={it.handle}
                        className="flex items-center gap-3"
                        data-testid={`follow-request-${it.handle}`}
                    >
                        {it.avatar_url ? (
                            <img
                                src={it.avatar_url}
                                alt=""
                                className="h-8 w-8 rounded-full object-cover"
                            />
                        ) : (
                            <div className="h-8 w-8 rounded-full bg-amber-200" />
                        )}
                        <Link
                            to={`/u/${it.handle}`}
                            className="flex-1 text-sm text-amber-900 hover:underline"
                        >
                            {it.display_name || `@${it.handle}`}
                            <span className="ml-1 text-amber-700">@{it.handle}</span>
                        </Link>
                        <button
                            type="button"
                            disabled={busy === it.handle}
                            onClick={() => void onApprove(it.handle)}
                            className="px-2 py-1 text-xs font-medium bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
                            data-testid={`approve-${it.handle}`}
                        >
                            Approve
                        </button>
                        <button
                            type="button"
                            disabled={busy === it.handle}
                            onClick={() => void onDecline(it.handle)}
                            className="px-2 py-1 text-xs font-medium border border-amber-300 text-amber-900 rounded hover:bg-amber-100 disabled:opacity-50"
                            data-testid={`decline-${it.handle}`}
                        >
                            Decline
                        </button>
                    </li>
                ))}
            </ul>
            {error && (
                <p className="mt-2 text-xs text-red-600" role="alert">
                    {error}
                </p>
            )}
        </section>
    );
}
