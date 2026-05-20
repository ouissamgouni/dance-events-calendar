import { useCallback, useEffect, useState, type ReactNode } from 'react';
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
            <section className="rounded-lg border border-slate-200 bg-white p-4 mb-3">
                <h2 className="text-sm font-semibold text-slate-900 mb-2">Privacy &amp; visibility</h2>
                <p className="text-xs text-slate-600">
                    Pick a handle above to enable your public profile and visibility settings.
                </p>
            </section>
        );
    }

    return (
        <section className="rounded-lg border border-slate-200 bg-white p-4 mb-3">
            <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                    <h2 className="text-sm font-semibold text-slate-900">Privacy &amp; visibility</h2>
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
                <p className="text-xs text-slate-500">Loading…</p>
            ) : !profile ? (
                <p className="text-xs text-slate-500">{error || 'Unavailable.'}</p>
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
                                            <span className="text-xs font-medium text-slate-900">
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
                    {error && (
                        <p className="text-xs text-red-600">{error}</p>
                    )}
                </div>
            )}
        </section>
    );
}

/** Strip a full URL down to just the path-handle. Also handles bare handles. */
function extractHandle(url: string | null): string {
    if (!url) return '';
    try {
        return new URL(url).pathname.replace(/^\//, '').split('/')[0];
    } catch {
        return url.replace(/^@/, '').trim();
    }
}

type SocialField = 'instagram' | 'facebook';

function IgIcon() {
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5" aria-hidden="true">
            <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z" />
        </svg>
    );
}

function FbIcon() {
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5" aria-hidden="true">
            <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
        </svg>
    );
}

/**
 * Self-loading social-media editor. Always visible (not collapsible) —
 * lives directly in the Profile section of Account.
 */
export function ProfileLinksEditor({ handle }: { handle: string | null }) {
    const { user } = useAuth();
    const [profile, setProfile] = useState<PublicProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!handle) { setLoading(false); return; }
        setLoading(true);
        setProfile(null);
        setError(null);
        try {
            const p = await fetchPublicProfile(handle);
            setProfile(p);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load');
        } finally {
            setLoading(false);
        }
    }, [handle]);

    useEffect(() => { load(); }, [load, user?.user_id]);

    return (
        <div className="mt-3 border-t border-slate-100 pt-3">
            {!handle ? (
                <p className="text-xs text-slate-400">Set a handle above to add social links.</p>
            ) : loading ? (
                <p className="text-xs text-slate-400">Loading…</p>
            ) : !profile ? (
                <p className="text-xs text-slate-400">{error || 'Unavailable.'}</p>
            ) : (
                <SocialHandleRow
                    profile={profile}
                    onUpdated={(p) => setProfile(p)}
                    onError={(m) => setError(m)}
                />
            )}
            {error && profile && <p className="mt-1 text-xs text-red-600">{error}</p>}
        </div>
    );
}

function SocialHandleRow({
    profile,
    onUpdated,
    onError,
}: {
    profile: PublicProfile;
    onUpdated: (p: PublicProfile) => void;
    onError: (msg: string) => void;
}) {
    const igHandle = extractHandle(profile.instagram_url);
    const fbHandle = extractHandle((profile as unknown as Record<string, string | null>).facebook_url);
    const [editing, setEditing] = useState<SocialField | null>(null);
    const [draft, setDraft] = useState('');
    const [saving, setSaving] = useState(false);

    const startEdit = (field: SocialField) => {
        setDraft(field === 'instagram' ? igHandle : fbHandle);
        setEditing(field);
    };

    const cancel = () => { setEditing(null); setDraft(''); };

    const save = async () => {
        if (!editing) return;
        setSaving(true);
        const h = draft.replace(/^@/, '').trim();
        const url = h ? `https://${editing === 'instagram' ? 'instagram' : 'facebook'}.com/${h}` : '';
        try {
            const next = await updateMySocialLinks(
                editing === 'instagram' ? { instagram_url: url } : { facebook_url: url },
            );
            onUpdated(next);
            setEditing(null);
            setDraft('');
        } catch (err) {
            onError(err instanceof Error ? err.message : 'Failed to save');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="flex items-center gap-4 flex-wrap">
            <SocialChip
                icon={<IgIcon />}
                urlBase="https://instagram.com/"
                handle={igHandle}
                field="instagram"
                label="Instagram"
                editing={editing}
                draft={draft}
                saving={saving}
                onDraftChange={setDraft}
                onEdit={startEdit}
                onSave={save}
                onCancel={cancel}
            />
            <SocialChip
                icon={<FbIcon />}
                urlBase="https://facebook.com/"
                handle={fbHandle}
                field="facebook"
                label="Facebook"
                editing={editing}
                draft={draft}
                saving={saving}
                onDraftChange={setDraft}
                onEdit={startEdit}
                onSave={save}
                onCancel={cancel}
            />
        </div>
    );
}

function SocialChip({
    icon,
    urlBase,
    handle,
    field,
    label,
    editing,
    draft,
    saving,
    onDraftChange,
    onEdit,
    onSave,
    onCancel,
}: {
    icon: ReactNode;
    urlBase: string;
    handle: string;
    field: SocialField;
    label: string;
    editing: SocialField | null;
    draft: string;
    saving: boolean;
    onDraftChange: (v: string) => void;
    onEdit: (f: SocialField) => void;
    onSave: () => void;
    onCancel: () => void;
}) {
    const isEditing = editing === field;
    return (
        <div className="flex items-center gap-1 text-xs">
            <span className="text-slate-400 shrink-0 flex items-center">{icon}</span>
            {isEditing ? (
                <>
                    <span className="text-slate-400">@</span>
                    <input
                        type="text"
                        value={draft}
                        onChange={(e) => onDraftChange(e.target.value)}
                        placeholder="yourhandle"
                        autoFocus
                        className="w-28 border-b border-slate-300 text-xs py-0.5 outline-none focus:border-blue-500 bg-transparent"
                    />
                    <button
                        type="button"
                        onClick={onSave}
                        disabled={saving}
                        className="ml-1 text-xs text-blue-500 hover:text-blue-600 font-medium disabled:opacity-50 shrink-0"
                    >
                        {saving ? '…' : 'Save'}
                    </button>
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={saving}
                        className="text-xs text-slate-400 hover:text-slate-600 shrink-0"
                    >
                        ✕
                    </button>
                </>
            ) : handle ? (
                <>
                    <a
                        href={`${urlBase}${handle}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-blue-500 hover:underline"
                    >
                        @{handle}
                    </a>
                    <button
                        type="button"
                        onClick={() => onEdit(field)}
                        className="text-slate-400 hover:text-slate-600 leading-none"
                        aria-label={`Edit ${label}`}
                        title={`Edit ${label}`}
                    >
                        ✎
                    </button>
                </>
            ) : (
                <button
                    type="button"
                    onClick={() => onEdit(field)}
                    className="text-slate-400 hover:text-slate-600 flex items-center gap-0.5"
                    aria-label={`Add ${label}`}
                    title={`Add ${label}`}
                >
                    <span className="text-xs">Add</span>
                    <span>✎</span>
                </button>
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
