import { useEffect, useState } from 'react';
import { CalendarDays, ChevronLeft } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { fetchSharedMyPlan } from '../api';
import MyPlanList from '../components/program/MyPlanList';
import type { SharedMyPlanResponse } from '../types';

export default function SharedMyPlanPage() {
    const { token } = useParams<{ token: string }>();
    const [data, setData] = useState<SharedMyPlanResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);

    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        setLoading(true);
        setNotFound(false);
        fetchSharedMyPlan(token)
            .then((value) => {
                if (!cancelled) setData(value);
            })
            .catch(() => {
                if (!cancelled) {
                    setData(null);
                    setNotFound(true);
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, [token]);

    if (loading) {
        return <div className="flex min-h-full items-center justify-center bg-canvas px-6 text-sm text-ink-soft">Loading shared plan…</div>;
    }

    if (notFound || !data) {
        return (
            <div className="flex min-h-full flex-col items-center justify-center bg-canvas px-6 text-center">
                <CalendarDays className="h-9 w-9 text-muted" aria-hidden="true" />
                <h1 className="mt-4 text-lg font-bold text-ink">This plan is no longer available</h1>
                <p className="mt-2 text-sm text-ink-soft">The link may have been stopped or replaced.</p>
                <Link to="/" className="mt-5 text-sm font-semibold text-action">Browse events</Link>
            </div>
        );
    }

    const title = data.owner_display_name
        ? `${data.owner_display_name}'s plan for ${data.event_title}`
        : `Shared plan for ${data.event_title}`;

    return (
        <div className="flex min-h-full flex-col bg-canvas">
            <header className="shrink-0 border-b border-line bg-surface px-4 py-4">
                <div className="mx-auto max-w-2xl">
                    <Link to={`/event/${data.event_id}`} className="inline-flex items-center gap-1 text-sm font-semibold text-action">
                        <ChevronLeft size={17} aria-hidden="true" />
                        Event details
                    </Link>
                    <h1 className="mt-3 text-2xl font-bold text-ink">{title}</h1>
                    <div className="mt-3 flex items-center justify-between gap-3">
                        <p className="text-sm text-ink-soft">This shared plan updates when its owner changes it.</p>
                        <Link to={`/event/${data.event_id}/program`} className="shrink-0 text-sm font-semibold text-action">Full program</Link>
                    </div>
                </div>
            </header>
            {data.entries.length ? (
                <MyPlanList schedule={data.schedule} entries={data.entries} />
            ) : (
                <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
                    <CalendarDays className="h-9 w-9 text-muted" aria-hidden="true" />
                    <h2 className="mt-4 text-lg font-bold text-ink">This plan is empty</h2>
                    <p className="mt-2 text-sm text-ink-soft">The owner has not added any sessions yet.</p>
                </div>
            )}
        </div>
    );
}
