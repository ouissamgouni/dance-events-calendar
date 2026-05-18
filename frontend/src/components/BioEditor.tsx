import { useCallback, useEffect, useState } from 'react';
import {
    fetchPublicProfile,
    updateMyBio,
    type PublicProfile,
} from '../api';
import { useAuth } from '../context/AuthContext';

const BIO_MAX = 280;

/**
 * Self-loading bio editor (Phase D). Lives inside the Profile section of
 * Account and persists via ``PATCH /social/me/bio``. Empty input clears
 * the bio. Length is enforced both in-UI (counter) and server-side
 * (max_length=280 + control-char strip).
 *
 * We fetch the public profile here (rather than threading it down from
 * Account) so this stays a drop-in component — same pattern as
 * VisibilitySection.
 */
export default function BioEditor({ handle }: { handle: string | null }) {
    const { user } = useAuth();
    const [profile, setProfile] = useState<PublicProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [bio, setBio] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!handle) {
            setLoading(false);
            return;
        }
        setLoading(true);
        setProfile(null);
        setError(null);
        try {
            const p = await fetchPublicProfile(handle);
            setProfile(p);
            setBio(p.bio ?? '');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load bio');
        } finally {
            setLoading(false);
        }
    }, [handle]);

    useEffect(() => { load(); }, [load, user?.user_id]);

    if (!handle) {
        return (
            <div className="mt-4 border-t border-slate-100 pt-4">
                <div className="text-sm font-medium text-slate-800 mb-1">Bio</div>
                <p className="text-xs text-slate-500">
                    Pick a handle above to add a bio to your public profile.
                </p>
            </div>
        );
    }

    const dirty = profile ? bio !== (profile.bio ?? '') : false;
    const remaining = BIO_MAX - bio.length;
    const overLimit = remaining < 0;

    const save = async () => {
        if (overLimit || !profile) return;
        setSaving(true);
        setError(null);
        try {
            // Server normalizes empty/whitespace -> NULL; pass the trimmed
            // string and let the backend decide so the rules stay in one
            // place.
            const next = await updateMyBio(bio.trim() ? bio : null);
            setProfile(next);
            setBio(next.bio ?? '');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save bio');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="mt-4 border-t border-slate-100 pt-4">
            <div className="text-sm font-medium text-slate-800 mb-1">Bio</div>
            <p className="text-xs text-slate-500 mb-2">
                A short blurb shown on your public profile. {BIO_MAX} characters max.
            </p>
            {loading ? (
                <p className="text-sm text-slate-500">Loading…</p>
            ) : !profile ? (
                <p className="text-sm text-slate-500">{error || 'Unavailable.'}</p>
            ) : (
                <>
                    <textarea
                        value={bio}
                        onChange={(e) => setBio(e.target.value)}
                        rows={3}
                        maxLength={BIO_MAX + 50 /* allow paste-overflow then warn */}
                        placeholder="Tell people what you're into…"
                        className="w-full text-sm border border-slate-200 px-2 py-1.5 focus:outline-none focus:border-blue-500"
                    />
                    <div className="mt-1 flex items-center justify-between gap-2">
                        <span
                            className={
                                'text-xs ' +
                                (overLimit ? 'text-red-600' : 'text-slate-400')
                            }
                        >
                            {remaining} characters left
                        </span>
                        <div className="flex gap-2">
                            {dirty && !saving && (
                                <button
                                    type="button"
                                    onClick={() => setBio(profile.bio ?? '')}
                                    className="text-xs text-slate-600 hover:text-slate-900"
                                >
                                    Cancel
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={save}
                                disabled={!dirty || saving || overLimit}
                                className="text-xs px-3 py-1 bg-blue-500 text-white disabled:opacity-50"
                            >
                                {saving ? 'Saving…' : 'Save bio'}
                            </button>
                        </div>
                    </div>
                    {error && (
                        <p className="mt-1 text-xs text-red-600">{error}</p>
                    )}
                </>
            )}
        </div>
    );
}
