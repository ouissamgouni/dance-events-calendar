import { useState } from 'react';
import type { ReactNode } from 'react';
import type { CalendarEvent } from '../types';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import EventCardPlaceholder from '../components/EventCardPlaceholder';

interface Options {
    /** Caller-side gate on top of the pictures flag (e.g. past events). */
    show?: boolean;
    /** Sizing and spacing shared by the picture and its placeholder. */
    className?: string;
    imageTestId?: string;
}

interface Result {
    /** True only when a real picture is on screen (not the placeholder). */
    imageVisible: boolean;
    /** The artwork to render, or ``null`` when the card shows none. */
    node: ReactNode;
}

/**
 * Card artwork: the stored picture, or the configured placeholder when the
 * event has none. Yields nothing when pictures are off, when the caller opts
 * out, or when the placeholder style is ``none``.
 */
export function useEventCardImage(event: CalendarEvent, options: Options = {}): Result {
    const { show = true, className = '', imageTestId = 'event-card-image' } = options;
    const { eventImagesEnabled, eventCardPlaceholderStyle } = useFeatureFlags();
    const [imageFailed, setImageFailed] = useState(false);

    // Prefer the cropped variant when the picture is object-storage managed;
    // ``image_url`` is the legacy/plain URL fallback.
    const src = event.image_thumb_url ?? event.image_url ?? null;
    const allowed = show && eventImagesEnabled;
    const imageVisible = allowed && !!src && !imageFailed;
    // Keep the layout identical when a picture is missing or failed to load,
    // unless the admin picked the ``none`` placeholder.
    const placeholderVisible = allowed && !imageVisible && eventCardPlaceholderStyle !== 'none';

    const node = imageVisible ? (
        <img
            src={src ?? undefined}
            alt=""
            className={`object-cover ${className}`}
            onError={() => setImageFailed(true)}
            data-testid={imageTestId}
        />
    ) : placeholderVisible ? (
        <EventCardPlaceholder
            seed={event.event_id}
            title={event.title}
            style={eventCardPlaceholderStyle}
            className={className}
        />
    ) : null;

    return { imageVisible, node };
}
