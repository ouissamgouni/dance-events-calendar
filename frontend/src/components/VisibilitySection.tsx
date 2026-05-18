import { useCallback, useEffect, useState } from 'react';
import {
    fetchPublicProfile,
    updateMySocialLinks,
    updateMyVisibility,
    type AccountVisibility,
    type PublicProfile,
    type ShareAudience,
} from '../api';
import MySubscribersBadge from './MySubscribersBadge';
import AudiencePicker from './AudiencePicker';
import { useAuth } from '../context/AuthContext';

const ACCOUNT_VISIBILITY_OPTIONS: { value: AccountVisibility; label: string; help: string }[] = [
    {
        value: 'public',
        label: 'Public',
        help: 'Anyone can find your profile, follow you, and see your public activity.',
    },
    {
        value: 'friends',
        label: 'Friends only',
        help: 'Only mutual followers (friends) can see your profile, calendar, and activity.',
    },
];

/**
 * Privacy & profile-links section for the Account page.
 *
 * Loads the authenticated user's public profile (single source of truth for
 * visibility + social-link state) and patches it via the social API. We
 * intentionally don't read these fields off the AuthContext user payload so
 * we don't have to thread them through that context just for this section.
 */
export default function VisibilitySection({ handle }: { handle: string | null }) {
    const { user } = useAuth();
    const [profile, setProfile] = useState<PublicProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [savingScope, setSavingScope] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!handle) {
            setLoading(false);
            return;
        }
        // Reset loading + profile so a re-fetch (e.g. handle becomes
        // available after AuthContext finishes hydrating) shows the
        // "Loading…" state instead of briefly rendering the
        // "Unavailable." fallback while the request is in flight.
        setLoading(true);
        setProfile(null);
        setError(null);
        try {
            const p = await fetchPublicProfile(handle);
            setProfile(p);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load profile');
        } finally {
            setLoading(false);
        }
    }, [handle]);

    // Re-fetch whenever the handle changes OR the auth user identity
    // changes — covers the first-paint race where the section renders
    // before AuthContext has hydrated user.handle, and lets the panel
    // self-heal if the user updates their handle in another tab.
    useEffect(() => { load(); }, [load, user?.user_id]);

    const setAccountVisibility = async (value: AccountVisibility) => {
        if (!profile) return;
        const prev = profile;
        setProfile({ ...profile, account_visibility: value });
        setSavingScope('account_visibility');
        try {
            const next = await updateMyVisibility({ account_visibility: value });
            setProfile(next);
        } catch (err) {
            setProfile(prev);
            setError(err instanceof Error ? err.message : 'Failed to save');
        } finally {
            setSavingScope(null);
        }
    };

    if (!handle) {
        return (
            <section className="rounded-lg border border-slate-200 bg-white p-6 mb-6">
                <h2 className="text-base font-semibold text-slate-900 mb-2">Privacy &amp; visibility</h2>
                <p className="text-sm text-slate-600">
                    Pick a handle above to enable your public profile and visibility settings.
                </p>
            </section>
        );
    }

    return (
        <section className="rounded-lg border border-slate-200 bg-white p-6 mb-6">
            <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                    <h2 className="text-base font-semibold text-slate-900">Privacy &amp; visibility</h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                        Control who can see your activity at <span className="font-mono">/u/{handle}</span>.
                        Your email is never shown publicly.
                    </p>
                </div>
                <a
                    href={`/u/${handle}`}
                    className="shrink-0 text-xs text-blue-600 hover:underline"
                    target="_blank"
                    rel="noreferrer"
                >
                    Preview my profile →
                </a>
            </div>

            {loading ? (
                <p className="text-sm text-slate-500">Loading…</p>
            ) : !profile ? (
                <p className="text-sm text-slate-500">{error || 'Unavailable.'}</p>
            ) : (
                <div className="space-y-5">
                    <div>
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2 flex items-center gap-2">
                            <span>Account visibility</span>
                            <MySubscribersBadge />
                        </div>
                        <p className="text-xs text-slate-500 mb-3">
                            One gate covers your profile, calendar, attendance,
                            and saved events. Per-event audience (public /
                            friends / only me) still applies independently.
                        </p>
                        <div className="space-y-3">
                            {ACCOUNT_VISIBILITY_OPTIONS.map((opt) => {
                                const active = profile.account_visibility === opt.value;
                                return (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        disabled={savingScope === 'account_visibility'}
                                        onClick={() => setAccountVisibility(opt.value)}
                                        className={
                                            'w-full text-left border px-4 py-3 transition ' +
                                            (active
                                                ? 'border-blue-500 bg-blue-50'
                                                : 'border-slate-200 bg-white hover:bg-slate-50')
                                        }
                                    >
                                        <div className="flex items-center justify-between">
                                            <span className="text-sm font-medium text-slate-900">
                                                {opt.label}
                                            </span>
                                            {active && (
                                                <span className="text-xs font-semibold text-blue-600">
                                                    Current
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-xs text-slate-500 mt-1">{opt.help}</div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div className="border-t border-slate-100 pt-4">
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                            When I RSVP
                        </div>
                        <ShareAttendanceDefaultPicker
                            profile={profile}
                            onUpdated={(p) => setProfile(p)}
                            onError={(m) => setError(m)}
                        />
                    </div>
                    <div className="border-t border-slate-100 pt-4">
                        <SocialLinksEditor
                            profile={profile}
                            onUpdated={(p) => setProfile(p)}
                            onError={(m) => setError(m)}
                        />
                    </div>
                    {error && (
                        <p className="text-xs text-red-600">{error}</p>
                    )}
                </div>
            )}
        </section>
    );
}

function SocialLinksEditor({
    profile,
    onUpdated,
    onError,
}: {
    profile: PublicProfile;
    onUpdated: (p: PublicProfile) => void;
    onError: (msg: string) => void;
}) {
    const [ig, setIg] = useState(profile.instagram_url ?? '');
    const [fb, setFb] = useState(profile.facebook_url ?? '');
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        setIg(profile.instagram_url ?? '');
        setFb(profile.facebook_url ?? '');
    }, [profile.instagram_url, profile.facebook_url]);

    const dirty = ig !== (profile.instagram_url ?? '') || fb !== (profile.facebook_url ?? '');

    const save = async () => {
        setSaving(true);
        try {
            const next = await updateMySocialLinks({
                instagram_url: ig,
                facebook_url: fb,
            });
            onUpdated(next);
        } catch (err) {
            onError(err instanceof Error ? err.message : 'Failed to save links');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div>
            <div className="text-sm font-medium text-slate-800 mb-1">Profile links (optional)</div>
            <p className="text-xs text-slate-500 mb-2">
                Shown on your public profile as unverified links — do not put your email or
                phone number here.
            </p>
            <div className="grid sm:grid-cols-2 gap-3">
                <label className="block text-xs">
                    <span className="text-slate-600">Instagram URL</span>
                    <input
                        type="url"
                        value={ig}
                        onChange={(e) => setIg(e.target.value)}
                        placeholder="https://instagram.com/yourhandle"
                        className="mt-1 w-full border border-slate-200 px-2 py-1.5 text-sm"
                    />
                </label>
                <label className="block text-xs">
                    <span className="text-slate-600">Facebook URL</span>
                    <input
                        type="url"
                        value={fb}
                        onChange={(e) => setFb(e.target.value)}
                        placeholder="https://facebook.com/yourhandle"
                        className="mt-1 w-full border border-slate-200 px-2 py-1.5 text-sm"
                    />
                </label>
            </div>
            {dirty && (
                <div className="mt-3 flex justify-end">
                    <button
                        type="button"
                        onClick={save}
                        disabled={saving}
                        className="bg-blue-500 text-white px-3 py-1.5 text-sm font-medium hover:bg-blue-600 disabled:opacity-50"
                    >
                        {saving ? 'Saving…' : 'Save links'}
                    </button>
                </div>
            )}
        </div>
    );
}

/**
 * Per-user default audience for new RSVPs. Replacement for the legacy
 * boolean ShareAttendanceDefaultToggle: persisted server-side as
 * ``share_attendance_default_audience`` (``public | friends | private``).
 */
function ShareAttendanceDefaultPicker({
    profile,
    onUpdated,
    onError,
}: {
    profile: PublicProfile;
    onUpdated: (p: PublicProfile) => void;
    onError: (msg: string) => void;
}) {
    const [saving, setSaving] = useState(false);
    const value: ShareAudience = profile.share_attendance_default_audience ?? 'friends';
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
                <div className="text-sm font-medium text-slate-800">
                    Default audience for new RSVPs
                </div>
                <div className="text-xs text-slate-500">
                    Pre-selected when you tap “I’m going”. You can override it
                    per event from the audience picker.
                </div>
            </div>
            <AudiencePicker
                value={value}
                disabled={saving}
                size="compact"
                ariaLabel="Default RSVP audience"
                onChange={async (next) => {
                    if (next === value) return;
                    const prev = profile;
                    onUpdated({ ...profile, share_attendance_default_audience: next });
                    setSaving(true);
                    try {
                        const updated = await updateMyVisibility({
                            share_attendance_default_audience: next,
                        });
                        onUpdated(updated);
                    } catch (err) {
                        onUpdated(prev);
                        onError(err instanceof Error ? err.message : 'Failed to save');
                    } finally {
                        setSaving(false);
                    }
                }}
            />
        </div>
    );
}
