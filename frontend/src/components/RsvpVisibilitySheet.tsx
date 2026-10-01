import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import AudiencePicker from './AudiencePicker';
import BottomSheet from './BottomSheet';
import useMediaQuery from '../hooks/useMediaQuery';
import { useAuth } from '../context/AuthContext';
import { useOptionalFeatureFlags } from '../context/FeatureFlagsContext';
import { updateMyVisibility, type ShareAudience } from '../api';
import { getRememberAudience, setRememberAudience } from '../utils/audiencePreference';

interface SecondaryAction {
    label: string;
    onClick: () => void;
    tone?: 'neutral' | 'danger';
    icon?: ReactNode;
}

type PrimaryAction =
    | { label: string; onClick: () => void }
    | { label: string; to: string };

interface Props {
    anchorRef: RefObject<HTMLElement | null>;
    emoji: string;
    title: string;
    subtitle?: string;
    question?: string;
    audience?: ShareAudience;
    onAudienceChange?: (next: ShareAudience) => void;
    pickerAriaLabel?: string;
    description?: string;
    children?: ReactNode;
    secondaryAction?: SecondaryAction;
    /** Defaults to a "Done" button that closes the sheet. */
    primaryAction?: PrimaryAction;
    onClose: () => void;
}

interface PopoverPos { top: number; left: number; }

const POPOVER_WIDTH = 320;
const POPOVER_HEIGHT_ESTIMATE = 320;

/** Anchor under the trigger, flipping above it when there isn't room below. */
function computePopoverPos(trigger: HTMLElement): PopoverPos {
    const r = trigger.getBoundingClientRect();
    const margin = 8;
    const desiredLeft = r.left + r.width / 2 - POPOVER_WIDTH / 2;
    const maxLeft = window.innerWidth - POPOVER_WIDTH - margin;
    const left = Math.max(margin, Math.min(desiredLeft, maxLeft));
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const spaceAbove = r.top - margin;
    const top =
        spaceBelow >= POPOVER_HEIGHT_ESTIMATE || spaceBelow >= spaceAbove
            ? r.bottom + 6
            : Math.max(margin, r.top - POPOVER_HEIGHT_ESTIMATE - 6);
    return { top, left };
}

/**
 * Shared confirmation/visibility sheet for RSVP + save flows. Bottom sheet on
 * mobile, anchored popover on desktop; same content in both.
 */
export default function RsvpVisibilitySheet({
    anchorRef,
    emoji,
    title,
    subtitle,
    question,
    audience,
    onAudienceChange,
    pickerAriaLabel = 'Audience',
    description,
    children,
    secondaryAction,
    primaryAction,
    onClose,
}: Props) {
    const isMobile = useMediaQuery('(max-width: 639px)');
    const [pos, setPos] = useState<PopoverPos | null>(null);
    const { user, refreshUser } = useAuth();
    const { rsvpRememberVisibilityEnabled } = useOptionalFeatureFlags();
    const [remember, setRemember] = useState(() => getRememberAudience(user?.user_id) ?? true);
    const showRemember = rsvpRememberVisibilityEnabled && !!user && !!audience && !!onAudienceChange;

    const handleDone = () => {
        if (showRemember && user) {
            setRememberAudience(user.user_id, remember);
            if (remember && audience && audience !== user.share_attendance_default_audience) {
                updateMyVisibility({ share_attendance_default_audience: audience })
                    .then(() => refreshUser())
                    .catch(() => { /* best-effort; per-event audience already applied */ });
            }
        }
        onClose();
    };

    useEffect(() => {
        if (isMobile) return;
        const update = () => {
            if (anchorRef.current) setPos(computePopoverPos(anchorRef.current));
        };
        update();
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
        };
    }, [anchorRef, isMobile]);

    const btnSize = 'min-h-11 text-sm';
    const secondaryTone = secondaryAction?.tone === 'danger' ? 'text-danger' : 'text-ink';
    const primaryClass = `flex ${btnSize} flex-1 items-center justify-center rounded-field bg-action px-4 py-2 font-semibold text-white hover:opacity-90`;
    const primary = primaryAction ?? { label: 'Done', onClick: handleDone };

    const footer = (
        <div className="flex gap-3">
            {secondaryAction && (
                <button
                    type="button"
                    onClick={secondaryAction.onClick}
                    className={`flex ${btnSize} flex-1 items-center justify-center gap-2 rounded-field border border-line bg-surface px-4 py-2 font-semibold hover:bg-canvas ${secondaryTone}`}
                >
                    {secondaryAction.icon}
                    {secondaryAction.label}
                </button>
            )}
            {'to' in primary ? (
                <Link to={primary.to} className={primaryClass}>{primary.label}</Link>
            ) : (
                <button type="button" onClick={primary.onClick} className={primaryClass}>
                    {primary.label}
                </button>
            )}
        </div>
    );

    const body = (
        <>
            {children}
            {audience && onAudienceChange && (
                <div>
                    {question && (
                        <p className="mb-2 text-sm font-medium text-ink">
                            {question}
                        </p>
                    )}
                    <AudiencePicker
                        value={audience}
                        onChange={onAudienceChange}
                        size="sheet"
                        ariaLabel={pickerAriaLabel}
                    />
                    {description && (
                        <p className="mt-2 text-xs leading-5 text-ink-soft">
                            {description}
                        </p>
                    )}
                    {showRemember && (
                        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-ink">
                            <input
                                type="checkbox"
                                checked={remember}
                                onChange={(e) => setRemember(e.target.checked)}
                                className="h-4 w-4 accent-action"
                            />
                            Remember my choice for next time
                        </label>
                    )}
                </div>
            )}
        </>
    );

    if (isMobile) {
        return createPortal(
            <BottomSheet
                title={title}
                subtitle={subtitle}
                titleSize="large"
                variant="floating"
                onClose={onClose}
                layer="transient"
                dismissible={false}
                headerLeading={<span aria-hidden className="text-2xl leading-none">{emoji}</span>}
                footer={footer}
            >
                {body}
            </BottomSheet>,
            document.body,
        );
    }

    if (!pos) return null;

    return createPortal(
        <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={title}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
            className="z-[12000] overflow-hidden rounded-card border border-line bg-surface text-left shadow-xl"
        >
            <div className="flex items-start justify-between gap-2 border-b border-line px-4 pt-4 pb-3">
                <div className="flex min-w-0 items-start gap-2.5">
                    <span aria-hidden className="text-2xl leading-none">{emoji}</span>
                    <div className="min-w-0">
                        <p className="text-lg font-bold leading-6 text-ink">{title}</p>
                        {subtitle && (
                            <p className="mt-0.5 line-clamp-2 text-sm leading-5 text-ink-soft">{subtitle}</p>
                        )}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close"
                    className="-mt-1 -mr-2 flex h-8 w-8 shrink-0 items-center justify-center text-muted transition hover:bg-canvas hover:text-ink-soft"
                >
                    ✕
                </button>
            </div>
            <div className="px-4 py-3">{body}</div>
            <div className="border-t border-line px-4 py-3">{footer}</div>
        </div>,
        document.body,
    );
}
