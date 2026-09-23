/* eslint-disable no-restricted-syntax -- Profile avatars are circular by design. */
import { useState } from 'react';
import { Camera, Trash2 } from 'lucide-react';
import {
    deleteUserAvatar,
    uploadUserAvatar,
    type UserAvatarUpdate,
} from '../api';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

interface AvatarEditorProps {
    avatarUrl: string | null;
    hasCustomAvatar: boolean;
    name: string;
    onChange?: (avatar: UserAvatarUpdate) => void | Promise<void>;
    compact?: boolean;
}

export default function AvatarEditor({
    avatarUrl,
    hasCustomAvatar,
    name,
    onChange,
    compact = false,
}: AvatarEditorProps) {
    const [avatarOverride, setAvatarOverride] = useState<UserAvatarUpdate | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const currentUrl = avatarOverride?.avatar_url ?? avatarUrl;
    const custom = avatarOverride?.has_custom_avatar ?? hasCustomAvatar;

    const applyUpdate = async (update: UserAvatarUpdate) => {
        setAvatarOverride(update);
        await onChange?.(update);
    };

    const upload = async (file: File | undefined) => {
        if (!file) return;
        if (file.size > MAX_AVATAR_BYTES) {
            setError('Profile picture must be 5MB or smaller.');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await applyUpdate(await uploadUserAvatar(file));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Failed to upload profile picture');
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        setBusy(true);
        setError(null);
        try {
            await applyUpdate(await deleteUserAvatar());
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Failed to remove profile picture');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={compact ? 'space-y-2' : 'space-y-3 text-center'}>
            <div className={compact ? 'flex items-center gap-3' : 'flex flex-col items-center gap-3'}>
                {currentUrl ? (
                    <img
                        src={currentUrl}
                        alt="Your profile"
                        className={compact ? 'h-16 w-16 rounded-full object-cover' : 'h-24 w-24 rounded-full object-cover'}
                        referrerPolicy="no-referrer"
                    />
                ) : (
                    <div className={compact ? 'flex h-16 w-16 items-center justify-center rounded-full bg-canvas text-xl font-semibold text-ink-soft' : 'flex h-24 w-24 items-center justify-center rounded-full bg-canvas text-3xl font-semibold text-ink-soft'}>
                        {name.trim().charAt(0).toUpperCase() || '?'}
                    </div>
                )}
                <div className={compact ? 'flex flex-wrap gap-2' : 'flex justify-center gap-2'}>
                    <label className={busy ? 'inline-flex min-h-10 cursor-not-allowed items-center gap-2 border border-line bg-surface px-3 text-sm font-semibold text-ink opacity-50' : 'inline-flex min-h-10 cursor-pointer items-center gap-2 border border-line bg-surface px-3 text-sm font-semibold text-ink hover:bg-canvas'}>
                        <Camera className="h-4 w-4" aria-hidden="true" />
                        {busy ? 'Saving…' : currentUrl ? 'Change photo' : 'Add photo'}
                        <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            aria-label="Upload profile picture"
                            disabled={busy}
                            onChange={(event) => {
                                void upload(event.target.files?.[0]);
                                event.target.value = '';
                            }}
                            className="sr-only"
                        />
                    </label>
                    {custom && (
                        <button
                            type="button"
                            onClick={() => void remove()}
                            disabled={busy}
                            className="inline-flex min-h-10 items-center gap-2 px-3 text-sm font-semibold text-danger hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                            Remove
                        </button>
                    )}
                </div>
            </div>
            {!compact && <p className="text-xs text-ink-soft">Optional. JPEG, PNG or WebP, up to 5MB.</p>}
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </div>
    );
}
