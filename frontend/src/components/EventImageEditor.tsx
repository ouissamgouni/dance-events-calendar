import { useRef, useState } from 'react';
import { uploadEventImage, setEventImageFromUrl, deleteEventImage } from '../api';
import type { CalendarEvent } from '../types';

interface EventImageEditorProps {
    event: CalendarEvent;
    /** Called with the updated event after any successful mutation. */
    onChange: (event: CalendarEvent) => void;
}

/**
 * Admin-only picture management for a single event. Always available to admins
 * regardless of the ``event_images_enabled`` display flag, so pictures can be
 * curated before the feature is switched on for everyone.
 */
export default function EventImageEditor({ event, onChange }: EventImageEditorProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [urlValue, setUrlValue] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const preview = event.image_thumb_url ?? event.image_url ?? null;

    const run = async (action: () => Promise<CalendarEvent>) => {
        setBusy(true);
        setError(null);
        try {
            onChange(await action());
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
        await run(() => uploadEventImage(event.event_id, file));
    };

    const handleImport = async () => {
        const url = urlValue.trim();
        if (!url) return;
        await run(() => setEventImageFromUrl(event.event_id, url));
        setUrlValue('');
    };

    return (
        <section
            className="mb-4 rounded-card border border-card-line p-3"
            data-testid="event-image-editor"
        >
            <h2 className="mb-2 text-sm font-semibold text-ink">Picture</h2>

            <div className="flex items-start gap-3">
                {preview ? (
                    <img
                        src={preview}
                        alt=""
                        className="h-20 w-36 shrink-0 rounded-card object-cover"
                        data-testid="event-image-preview"
                    />
                ) : (
                    <div
                        className="flex h-20 w-36 shrink-0 items-center justify-center rounded-card border border-dashed border-card-line text-[11px] text-ink-soft"
                        data-testid="event-image-empty"
                    >
                        No picture
                    </div>
                )}

                <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={busy}
                            className="rounded-card bg-action px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                        >
                            Upload
                        </button>
                        {preview && (
                            <button
                                type="button"
                                onClick={() => run(() => deleteEventImage(event.event_id))}
                                disabled={busy}
                                className="rounded-card border border-card-line px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-50"
                                data-testid="event-image-remove"
                            >
                                Remove
                            </button>
                        )}
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            onChange={handleFileChange}
                            className="hidden"
                            aria-label="Upload event picture"
                            data-testid="event-image-file"
                        />
                    </div>

                    <div className="flex items-center gap-2">
                        <input
                            type="url"
                            value={urlValue}
                            onChange={(e) => setUrlValue(e.target.value)}
                            placeholder="https://example.com/picture.jpg"
                            disabled={busy}
                            aria-label="Event picture URL"
                            className="min-w-0 flex-1 rounded-card border border-card-line bg-surface px-2 py-1.5 text-xs text-ink disabled:opacity-50"
                            data-testid="event-image-url"
                        />
                        <button
                            type="button"
                            onClick={handleImport}
                            disabled={busy || !urlValue.trim()}
                            className="rounded-card border border-card-line px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-50"
                            data-testid="event-image-import"
                        >
                            Import
                        </button>
                    </div>

                    {error && (
                        <p className="text-xs text-danger" data-testid="event-image-error">
                            {error}
                        </p>
                    )}
                </div>
            </div>
        </section>
    );
}
