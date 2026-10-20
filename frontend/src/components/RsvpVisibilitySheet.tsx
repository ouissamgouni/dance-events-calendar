import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import AudiencePicker from './AudiencePicker';
import BottomSheet from './BottomSheet';
import useMediaQuery from '../hooks/useMediaQuery';
import useBackToClose from '../hooks/useBackToClose';
import { useAuth } from '../context/AuthContext';
import { useOptionalFeatureFlags } from '../context/FeatureFlagsContext';
import { updateMyVisibility, type ShareAudience } from '../api';
import AudienceTierIcon from './AudienceTierIcon';
import {
    AUDIENCE_TIER_LABELS,
    defaultRsvpAudienceFor,
    defaultSavedAudienceFor,
    type AudienceKind,
} from '../utils/audiencePreference';

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
    /** Saves and RSVPs keep separate remembered choices. */
    kind: AudienceKind;
    emoji: ReactNode;
    title: string;
    subtitle?: string;
    audience?: ShareAudience;
    onAudienceChange?: (next: ShareAudience) => void;
    pickerAriaLabel?: string;
    children?: ReactNode;
    secondaryAction?: SecondaryAction;
    /** Defaults to a "Done" button that closes the sheet. */
    primaryAction?: PrimaryAction;
    /** Next-step link shown at the start of the footer row. */
    footerLink?: { label: string; to: string };
    /** Neutral styling when another CTA in the body is the primary one. */
    primaryTone?: 'primary' | 'neutral';
    onClose: () => void;
}

interface PopoverPos { top: number; left: number; }

const POPOVER_WIDTH = 320;
const POPOVER_HEIGHT_ESTIMATE = 180;

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
 * mobile; on desktop an anchored popover, or a centered modal when the
 * people-sheet flag is on.
 */
export default function RsvpVisibilitySheet({
    anchorRef,
    kind,
    emoji,
    title,
    subtitle,
    audience,
    onAudienceChange,
    pickerAriaLabel = 'Audience',
    children,
    secondaryAction,
    primaryAction,
    footerLink,
    primaryTone = 'primary',
    onClose,
}: Props) {
    const isMobile = useMediaQuery('(max-width: 639px)');
    const [pos, setPos] = useState<PopoverPos | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const { user, refreshUser } = useAuth();
    const { rsvpPeopleSheetEnabled } = useOptionalFeatureFlags();
    // Bottom sheet on mobile, centered modal on desktop.
    const asSheet = isMobile || rsvpPeopleSheetEnabled;
    const [defaultState, setDefaultState] = useState<'idle' | 'saving' | 'saved'>('idle');
    const showMakeDefault = rsvpPeopleSheetEnabled && kind === 'going' && !!user && !!audience && !!onAudienceChange
        && (defaultState === 'saved' || audience !== user.share_attendance_default_audience);
    const defaultAudience = user ? (kind === 'saved' ? defaultSavedAudienceFor(user) : defaultRsvpAudienceFor(user)) : null;
    const [pickerOpen, setPickerOpen] = useState(false);
    // The usual choice needs no decision: show a one-line summary until the user wants to change it.
    const collapsed = rsvpPeopleSheetEnabled && !pickerOpen && !!audience && audience === defaultAudience;

    const makeDefault = () => {
        if (!audience || defaultState === 'saving') return;
        setPickerOpen(true);
        setDefaultState('saving');
        updateMyVisibility({ share_attendance_default_audience: audience })
            .then(() => refreshUser())
            .then(() => setDefaultState('saved'))
            .catch(() => setDefaultState('idle'));
    };

    const dismiss = onClose;
    const dismissRef = useRef(dismiss);
    useEffect(() => {
        dismissRef.current = dismiss;
    });
    // BottomSheet owns back-button handling on mobile.
    useBackToClose(dismiss, !asSheet);

    useEffect(() => {
        if (asSheet) return;
        const onPointerDown = (e: PointerEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) dismissRef.current();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') dismissRef.current();
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [asSheet]);

    useEffect(() => {
        if (asSheet) return;
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
    }, [anchorRef, asSheet]);

    const btnBase = 'flex min-h-10 items-center justify-center gap-1.5 rounded-field px-3 text-sm font-semibold';
    const secondaryTone = secondaryAction?.tone === 'danger' ? 'text-danger' : 'text-ink';
    const primaryClass = primaryTone === 'neutral'
        ? `${btnBase} border border-line bg-surface px-4 text-ink hover:bg-canvas`
        : `${btnBase} bg-action px-4 text-white hover:opacity-90`;
    const primary = primaryAction ?? { label: 'Done', onClick: dismiss };

    const picker = audience && onAudienceChange ? (
        <AudiencePicker
            value={audience}
            onChange={(next) => {
                setPickerOpen(true);
                onAudienceChange(next);
            }}
            size="sheet"
            ariaLabel={pickerAriaLabel}
        />
    ) : null;

    const body = (
        <>
            {rsvpPeopleSheetEnabled ? (
                <>
                    {picker && audience && collapsed && (
                        <div className="mb-4 flex items-center justify-between gap-2" data-testid="rsvp-visibility-summary">
                            <span className="flex min-w-0 items-center gap-1.5 text-sm text-ink-soft">
                                <AudienceTierIcon audience={audience} className="h-4 w-4 shrink-0" />
                                Visible to: <span className="font-medium text-ink">{AUDIENCE_TIER_LABELS[audience]}</span>
                            </span>
                            <button
                                type="button"
                                onClick={() => setPickerOpen(true)}
                                className="text-xs font-medium text-action hover:underline"
                            >
                                Change
                            </button>
                        </div>
                    )}
                    {picker && !collapsed && (
                        <div className="mb-4" data-testid="rsvp-visibility-row">
                            <div className="mb-1.5 flex items-center justify-between gap-2">
                                <span className="text-xs font-medium text-ink-soft">
                                    {kind === 'saved' ? 'Who sees you saved it' : 'Who sees you’re going'}
                                </span>
                                {showMakeDefault && (
                                    defaultState === 'saved' ? (
                                        <span className="text-xs text-ink-soft">Saved as default</span>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={makeDefault}
                                            disabled={defaultState === 'saving'}
                                            className="text-xs font-medium text-action hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            Make default
                                        </button>
                                    )
                                )}
                            </div>
                            {picker}
                        </div>
                    )}
                    {children}
                </>
            ) : (
                <>
                    {children}
                    {picker}
                </>
            )}
            <div className="mt-3 flex items-center gap-2">
                {footerLink && (
                    <Link
                        to={footerLink.to}
                        onClick={dismiss}
                        className="text-sm font-semibold text-action hover:underline"
                    >
                        {footerLink.label}
                    </Link>
                )}
                <div className="ml-auto flex items-center gap-2">
                    {secondaryAction && (
                        <button
                            type="button"
                            onClick={secondaryAction.onClick}
                            className={`${btnBase} border border-line bg-surface hover:bg-canvas ${secondaryTone}`}
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
            </div>
        </>
    );

    if (asSheet) {
        return createPortal(
            // Portal events still bubble through React ancestors (e.g. clickable cards).
            <div onClick={(e) => e.stopPropagation()}>
                <BottomSheet
                    title={title}
                    subtitle={subtitle}
                    variant="floating"
                    compact
                    desktop={rsvpPeopleSheetEnabled ? 'modal' : 'sheet'}
                    onClose={dismiss}
                    layer="transient"
                    headerLeading={<span aria-hidden className="text-xl leading-none">{emoji}</span>}
                >
                    {body}
                </BottomSheet>
            </div>,
            document.body,
        );
    }

    if (!pos) return null;

    return createPortal(
        <div
            ref={popoverRef}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={title}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
            className="z-[12000] overflow-hidden rounded-card border border-line bg-surface p-4 text-left shadow-xl"
        >
            <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                    <span aria-hidden className="text-xl leading-none">{emoji}</span>
                    <div className="min-w-0">
                        <p className="text-base font-bold leading-6 text-ink">{title}</p>
                        {subtitle && (
                            <p className="truncate text-sm leading-5 text-ink-soft">{subtitle}</p>
                        )}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={dismiss}
                    aria-label="Close"
                    className="-mr-2 flex h-8 w-8 shrink-0 items-center justify-center text-muted transition hover:bg-canvas hover:text-ink-soft"
                >
                    ✕
                </button>
            </div>
            {body}
        </div>,
        document.body,
    );
}
