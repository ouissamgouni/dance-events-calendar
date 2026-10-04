import { useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { importSuggestionImageFromUrl, uploadSuggestionImage, type SuggestionImage } from '../../api';
import SubPage from './SubPage';
import { btnPrimary, btnSecondary, fieldErrorCls, fieldLabelCls, helpCls, inputCls, isUrlValid } from './formState';

/** Matches the backend's default EVENT_IMAGE_MAX_BYTES. */
const MAX_BYTES = 8 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const inlineBtnCls =
    'flex min-h-12 shrink-0 items-center justify-center rounded-field border border-line bg-surface px-4 text-sm font-semibold transition hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50';

interface Props {
    value: SuggestionImage | null;
    onSave: (image: SuggestionImage | null) => void;
    onClose: () => void;
}

/** Full-screen cover photo picker: upload a file or import from a link. */
export default function ImagePage({ value, onSave, onClose }: Props) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [image, setImage] = useState<SuggestionImage | null>(value);
    const [url, setUrl] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = async (action: () => Promise<SuggestionImage>) => {
        setBusy(true);
        setError(null);
        try {
            setImage(await action());
            setUrl('');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Something went wrong.');
        } finally {
            setBusy(false);
        }
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        // Reset so picking the same file again still fires a change event.
        e.target.value = '';
        if (!file) return;
        if (!ACCEPTED_TYPES.includes(file.type)) {
            setError('Only JPEG, PNG and WebP images are supported.');
            return;
        }
        if (file.size > MAX_BYTES) {
            setError('Image is larger than 8MB.');
            return;
        }
        await run(() => uploadSuggestionImage(file));
    };

    const trimmedUrl = url.trim();
    const urlValid = trimmedUrl.startsWith('https://') && isUrlValid(trimmedUrl);

    const done = () => {
        onSave(image);
        onClose();
    };

    return (
        <SubPage
            title="Cover photo"
            onBack={onClose}
            footer={
                <button
                    type="button"
                    className={btnPrimary}
                    onClick={done}
                    disabled={busy}
                >
                    Done
                </button>
            }
        >
            {image ? (
                <img
                    src={image.image_thumb_url}
                    alt="Cover photo preview"
                    className="aspect-video w-full rounded-card object-cover"
                />
            ) : (
                <div className="flex aspect-video w-full items-center justify-center rounded-card border border-dashed border-line text-sm text-muted">
                    No cover photo
                </div>
            )}

            <div className="mt-4 flex gap-2">
                <button
                    type="button"
                    className={`${btnSecondary} disabled:cursor-not-allowed disabled:opacity-50`}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={busy}
                >
                    <ImagePlus size={18} className="mr-2" aria-hidden="true" />
                    {busy ? 'Uploading…' : image ? 'Replace photo' : 'Upload photo'}
                </button>
                {image ? (
                    <button
                        type="button"
                        className={`${inlineBtnCls} text-danger`}
                        onClick={() => setImage(null)}
                        disabled={busy}
                    >
                        Remove
                    </button>
                ) : null}
            </div>
            <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_TYPES.join(',')}
                className="hidden"
                onChange={handleFileChange}
                data-testid="suggest-image-file"
            />
            <p className={helpCls}>JPEG, PNG or WebP, up to 8MB.</p>

            <label className={`${fieldLabelCls} mt-6`} htmlFor="suggest-image-url">
                Or paste an image link
            </label>
            <div className="flex gap-2">
                <input
                    id="suggest-image-url"
                    type="url"
                    inputMode="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://"
                    className={inputCls}
                    disabled={busy}
                />
                <button
                    type="button"
                    className={`${inlineBtnCls} text-ink`}
                    onClick={() => run(() => importSuggestionImageFromUrl(trimmedUrl))}
                    disabled={busy || !urlValid}
                >
                    Import
                </button>
            </div>

            {error ? (
                <p className={fieldErrorCls} role="alert">
                    {error}
                </p>
            ) : null}
        </SubPage>
    );
}
