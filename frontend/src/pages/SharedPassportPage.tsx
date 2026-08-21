/**
 * Public, read-only Dance Passport (shared link). Renders the same
 * PassportView surface the owner sees — stats, milestones and the
 * cities/countries map — minus the private timeline. No sign-in required.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchSharedPassport } from '../api';
import PassportView from '../components/PassportView';
import PassportFollowCta from '../components/PassportFollowCta';
import type { SharedPassportResponse } from '../types';

export default function SharedPassportPage() {
    const { token } = useParams<{ token: string }>();
    const [data, setData] = useState<SharedPassportResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);
    const [signinRequired, setSigninRequired] = useState(false);

    useEffect(() => {
        if (!token) return;
        setLoading(true);
        setNotFound(false);
        setSigninRequired(false);
        fetchSharedPassport(token)
            .then(setData)
            .catch((e: unknown) => {
                setData(null);
                if (e instanceof Error && e.message === 'SIGNIN_REQUIRED') {
                    setSigninRequired(true);
                } else {
                    setNotFound(true);
                }
            })
            .finally(() => setLoading(false));
    }, [token]);

    const name = data?.display_name ?? 'A dancer';
    const title = `${name}${name.endsWith('s') ? "'" : "'s"} Dance Passport`;

    return (
        <div className="min-h-screen bg-[#f8fafc]">
            <main className="mx-auto max-w-3xl px-4 py-6">
                <Link to="/" className="text-sm text-action hover:underline">
                    ← Browse events
                </Link>

                {loading && (
                    <div className="mt-4 border border-line bg-surface p-6 text-center text-sm text-ink-soft">
                        Loading passport…
                    </div>
                )}

                {!loading && notFound && (
                    <div className="mt-4 border border-line bg-surface p-6 text-center text-sm text-ink-soft">
                        This passport link is no longer available.
                    </div>
                )}

                {!loading && signinRequired && (
                    <div className="mt-4 border border-line bg-surface p-6 text-center">
                        <p className="text-sm text-ink-soft">
                            This passport is shared with signed-in dancers only.
                        </p>
                        <Link
                            to="/login"
                            className="mt-4 inline-block bg-action px-4 py-2 text-sm font-medium text-white hover:bg-action"
                        >
                            Sign in to view
                        </Link>
                    </div>
                )}

                {!loading && data && (
                    <div className="mt-4">
                        <PassportView
                            data={data}
                            title={title}
                            sections={data.sections}
                            headerActions={
                                <div className="flex justify-end">
                                    <PassportFollowCta
                                        handle={data.handle}
                                        isSelf={data.is_self}
                                        isFollowing={data.is_following}
                                        displayName={data.display_name}
                                    />
                                </div>
                            }
                            timelineItems={data.timeline_items}
                            timelineMarkers={data.timeline_markers}
                            mapEvents={data.events}
                        />
                    </div>
                )}
            </main>
        </div>
    );
}
