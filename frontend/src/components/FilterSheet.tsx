import { useEffect, useState } from 'react';
import FullScreenEditor from './FullScreenEditor';

// FilterSheet — the explorer's filter hub. In sectioned mode it renders a
// list of filter dimensions (Area, Dates, Dance styles, Event reach, Event
// format, People, More filters); tapping a row pushes a full-screen
// sub-editor over the sheet. All filter state is lifted in the parent
// (Home); this component owns only the open/close + section-navigation
// chrome and the Reset / Clear all / Save-as-defaults actions. A legacy
// ``children`` mode is kept for surfaces (e.g. the calendar view) that still
// render a flat control stack.
//
// Renders as a bottom sheet on mobile (`variant` "sheet") or a centered
// modal on desktop (`variant` "modal").
//
// Square corners, blue-500 primary, secondary slate chrome per
// .github/instructions/frontend.instructions.md.

export interface FilterSheetSection {
    id: string;
    label: string;
    icon?: React.ReactNode;
    /** Short summary of the current value, shown on the row. */
    summary: React.ReactNode;
    /** Optional compact visual shown beside the row summary. */
    preview?: React.ReactNode;
    /** Count contributed to the "+N" secondary badge, if any. */
    badge?: number;
    /** Renders the sub-editor body for this section. Omit for ``customRow``. */
    render?: () => React.ReactNode;
    /** Optional right-aligned header action inside the sub-editor. */
    headerAction?: React.ReactNode;
    /** Custom sub-editor footer; when omitted the default CTA is used. */
    footer?: React.ReactNode;
    /** Group label rendered above the group. For ``boxed`` groups it renders
     *  as a small inset label inside the card; ``plain`` groups render no
     *  heading (rows sit directly on the sheet). */
    group?: string;
    /** How the group this section belongs to is rendered. ``boxed`` wraps the
     *  group's rows in a bordered card with the group label inset (e.g. Search
     *  profile); ``plain`` (default) renders headerless rows. */
    groupVariant?: 'plain' | 'boxed';
    /** Replaces the default navigable row (e.g. a profile selector or a
     *  secondary text action). The node owns its own interaction; the section
     *  is not navigable. */
    customRow?: React.ReactNode;
    /** Optional right-aligned action in the boxed group header. Rendered in
     *  the small uppercase header row alongside the group label. */
    groupHeaderAction?: React.ReactNode;
}

export interface SaveDefaultsOption {
    id: string;
    label: string;
    description?: string;
    disabled?: boolean;
}

export interface FilterSheetProps {
    open: boolean;
    onClose: () => void;
    /** Sectioned mode: filter dimensions rendered as navigable rows. */
    sections?: FilterSheetSection[];
    /** Deep-link: jump straight into this section when the sheet opens. */
    initialSectionId?: string | null;
    /** Restore filters to the user's saved defaults. */
    onReset?: () => void;
    /** Clear every filter to the unrestricted state. */
    onClearAll?: () => void;
    activeFilterCount: number;
    matchingEventCount: number;
    variant?: 'sheet' | 'modal';
    /** Selective "Save as my defaults" configuration. */
    saveDefaults?: {
        options: SaveDefaultsOption[];
        onSave: (selectedIds: string[]) => Promise<void> | void;
    };
    /** Legacy flat-control mode (used by the calendar view). */
    children?: React.ReactNode;
}

const SAVE_DEFAULTS_ID = '__save_defaults__';

export default function FilterSheet({
    open,
    onClose,
    sections,
    initialSectionId = null,
    onReset,
    onClearAll,
    activeFilterCount,
    matchingEventCount,
    variant = 'sheet',
    saveDefaults,
    children,
}: FilterSheetProps) {
    const sectioned = !!sections && sections.length > 0;
    const [activeSectionId, setActiveSectionId] = useState<string | null>(initialSectionId);

    // On open, honor a deep-link section; on close, reset navigation so the
    // next open starts from the section list (unless deep-linked again).
    // Done during render (React's "adjusting state on prop change" pattern)
    // rather than in an effect to avoid a cascading re-render.
    const [navSync, setNavSync] = useState({ open, initialSectionId });
    if (navSync.open !== open || navSync.initialSectionId !== initialSectionId) {
        setNavSync({ open, initialSectionId });
        setActiveSectionId(open ? initialSectionId : null);
    }

    // Lock body scroll while open and close on Escape (only from the section
    // list — sub-editors handle their own Escape to step back).
    useEffect(() => {
        if (!open) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && activeSectionId === null) onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => {
            document.body.style.overflow = previous;
            window.removeEventListener('keydown', onKey);
        };
    }, [open, onClose, activeSectionId]);

    if (!open) return null;

    const chevron = (
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 4l6 6-6 6" />
        </svg>
    );

    const ctaLabel = matchingEventCount === 0
        ? 'No matching events'
        : `Show ${matchingEventCount} event${matchingEventCount === 1 ? '' : 's'}`;

    const header = (
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <h2 className="text-sm font-semibold text-ink">Filters</h2>
            <div className="flex items-center gap-1">
                {onReset && (
                    <button
                        type="button"
                        onClick={onReset}
                        className="text-xs text-ink-soft hover:text-ink underline-offset-2 hover:underline"
                        data-testid="filter-sheet-reset"
                    >
                        Reset to defaults
                    </button>
                )}
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close filters"
                    className="inline-flex h-7 w-7 items-center justify-center text-ink-soft hover:text-ink hover:bg-canvas"
                >
                    ×
                </button>
            </div>
        </div>
    );

    const footer = (
        <div className="border-t border-line bg-canvas px-3 py-2 flex flex-col gap-2">
            {saveDefaults && saveDefaults.options.length > 0 && (
                <button
                    type="button"
                    onClick={() => setActiveSectionId(SAVE_DEFAULTS_ID)}
                    className="text-xs text-action hover:underline underline-offset-2 text-left"
                    data-testid="filter-sheet-save-defaults"
                >
                    Save current as my defaults…
                </button>
            )}
            <div className="flex items-center justify-between gap-3">
                <button
                    type="button"
                    onClick={onClearAll}
                    disabled={!onClearAll || activeFilterCount === 0}
                    className="text-xs text-ink-soft hover:text-ink underline-offset-2 hover:underline disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:no-underline"
                    data-testid="filter-sheet-clear-all"
                >
                    Clear all
                </button>
                <button
                    type="button"
                    onClick={onClose}
                    className="inline-flex items-center bg-action hover:bg-action text-white text-sm font-semibold px-3 py-1.5 shadow-sm transition"
                    data-testid="filter-sheet-apply"
                >
                    {ctaLabel}
                </button>
            </div>
        </div>
    );

    const renderNavRow = (section: FilterSheetSection) => {
        if (section.customRow) {
            return (
                <li key={section.id} data-testid={`filter-sheet-row-${section.id}`}>
                    {section.customRow}
                </li>
            );
        }
        const summaryMuted = section.summary === 'Any' || section.summary === 'None';
        return (
            <li key={section.id}>
                <button
                    type="button"
                    onClick={() => setActiveSectionId(section.id)}
                    className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-canvas"
                    data-testid={`filter-sheet-row-${section.id}`}
                >
                    {section.icon && <span className="shrink-0 text-ink-soft">{section.icon}</span>}
                    <span className="shrink-0 text-sm font-medium text-ink">{section.label}</span>
                    {section.badge ? (
                        <span className="shrink-0 inline-flex h-4 min-w-4 items-center justify-center bg-blue-100 px-1 text-[10px] font-semibold text-blue-700">
                            {section.badge}
                        </span>
                    ) : null}
                    <span
                        className={`ml-auto truncate text-xs ${summaryMuted ? 'text-muted' : 'text-ink-soft'}`}
                        data-testid={`filter-sheet-summary-${section.id}`}
                    >
                        {section.summary}
                    </span>
                    {section.preview}
                    {chevron}
                </button>
            </li>
        );
    };

    // Split the ordered sections into consecutive groups so each named group
    // gets a single uppercase heading and its own row dividers. Ungrouped
    // sections (legacy callers) render headerless, as before.
    const grouped: { group?: string; variant?: FilterSheetSection['groupVariant']; sections: FilterSheetSection[] }[] = [];
    for (const section of sections ?? []) {
        const last = grouped[grouped.length - 1];
        if (last && last.group === section.group) last.sections.push(section);
        else grouped.push({ group: section.group, variant: section.groupVariant, sections: [section] });
    }

    const body = sectioned ? (
        <div className="filter-sheet-body flex-1 overflow-y-auto bg-canvas pt-2 pb-1">
            {grouped.map((grp, i) => {
                if (grp.variant === 'boxed') {
                    // Flat section header for boxed group: uppercase label + optional
                    // groupHeaderAction, with a full-width hairline underline.
                    const groupHeaderAction = grp.sections.find((s) => s.groupHeaderAction)?.groupHeaderAction;
                    return (
                        <div key={grp.group ?? `_${i}`}>
                            {(grp.group || groupHeaderAction) && (
                                <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-1.5 border-b border-line">
                                    {grp.group && (
                                        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-soft">
                                            {grp.group}
                                        </div>
                                    )}
                                    {groupHeaderAction && <div className="ml-auto">{groupHeaderAction}</div>}
                                </div>
                            )}
                            <ul>{grp.sections.map(renderNavRow)}</ul>
                            {i < grouped.length - 1 && <div className="border-t border-card-line py-2" />}
                        </div>
                    );
                }
                return (
                    <div key={grp.group ?? `_${i}`}>
                        <ul className="divide-y divide-card-line">{grp.sections.map(renderNavRow)}</ul>
                    </div>
                );
            })}
        </div>
    ) : (
        <div className="filter-sheet-body flex-1 overflow-y-auto bg-canvas px-3 py-2 flex flex-col gap-2">
            {children}
        </div>
    );

    const activeSection = sectioned && activeSectionId && activeSectionId !== SAVE_DEFAULTS_ID
        ? sections!.find((s) => s.id === activeSectionId && s.render) ?? null
        : null;

    const panelInner = (
        <>
            {header}
            {body}
            {footer}
            {activeSection && (
                <FullScreenEditor
                    title={activeSection.label}
                    onBack={() => setActiveSectionId(null)}
                    headerAction={activeSection.headerAction}
                    footer={activeSection.footer}
                    ctaLabel={activeSection.footer ? undefined : ctaLabel}
                    onCta={() => setActiveSectionId(null)}
                    variant={variant}
                >
                    {activeSection.render?.()}
                </FullScreenEditor>
            )}
            {activeSectionId === SAVE_DEFAULTS_ID && saveDefaults && (
                <SaveDefaultsEditor
                    options={saveDefaults.options}
                    onSave={saveDefaults.onSave}
                    onBack={() => setActiveSectionId(null)}
                    variant={variant}
                />
            )}
        </>
    );

    const panel = (
        <div
            className={
                variant === 'modal'
                    ? 'filter-modal-panel relative overflow-hidden w-full max-w-2xl h-[min(85dvh,calc(100dvh-4rem))] bg-surface border border-line shadow-xl flex flex-col'
                    : 'filter-sheet-panel relative overflow-hidden bg-surface border-t border-line shadow-xl flex flex-col'
            }
        >
            {panelInner}
        </div>
    );

    if (variant === 'modal') {
        return (
            <div
                className="fixed inset-0 z-[8500] flex items-center justify-center bg-slate-900/60 p-4"
                role="dialog"
                aria-modal="true"
                aria-label="Filters"
                data-testid="filter-sheet"
                onClick={activeSectionId === null ? onClose : undefined}
            >
                <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl">
                    {panel}
                </div>
            </div>
        );
    }

    return (
        <div
            className="fixed inset-0 z-[8500] flex flex-col"
            role="dialog"
            aria-modal="true"
            aria-label="Filters"
            data-testid="filter-sheet"
        >
            {/* Backdrop — tap to dismiss. Uses bg-slate-900/60 instead of an
                opacity utility on the backdrop to avoid bleeding into the
                sheet content. */}
            <button
                type="button"
                aria-label="Close filters"
                onClick={onClose}
                className="flex-1 bg-slate-900/60"
            />
            {panel}
        </div>
    );
}

function SaveDefaultsEditor({
    options,
    onSave,
    onBack,
    variant,
}: {
    options: SaveDefaultsOption[];
    onSave: (selectedIds: string[]) => Promise<void> | void;
    onBack: () => void;
    variant: 'sheet' | 'modal';
}) {
    const [selected, setSelected] = useState<Set<string>>(
        () => new Set(options.filter((o) => !o.disabled).map((o) => o.id)),
    );
    const [saving, setSaving] = useState(false);

    const toggle = (id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            await onSave([...selected]);
            onBack();
        } finally {
            setSaving(false);
        }
    };

    return (
        <FullScreenEditor
            title="Save as my defaults"
            onBack={onBack}
            variant={variant}
            ctaLabel={saving ? 'Saving…' : 'Save defaults'}
            onCta={handleSave}
            ctaDisabled={saving || selected.size === 0}
        >
            <p className="mb-2 text-xs text-ink-soft">
                Choose which parts of your current view to save as your defaults.
                These load automatically next time.
            </p>
            <ul className="flex flex-col gap-1">
                {options.map((opt) => (
                    <li key={opt.id}>
                        <label
                            className={`flex items-start gap-2 border border-line bg-surface px-2 py-2 text-sm ${opt.disabled ? 'opacity-50' : 'cursor-pointer hover:bg-canvas'}`}
                        >
                            <input
                                type="checkbox"
                                className="mt-0.5"
                                checked={selected.has(opt.id)}
                                disabled={opt.disabled}
                                onChange={() => toggle(opt.id)}
                                data-testid={`save-default-option-${opt.id}`}
                            />
                            <span className="flex flex-col">
                                <span className="font-medium text-ink">{opt.label}</span>
                                {opt.description && (
                                    <span className="text-xs text-ink-soft">{opt.description}</span>
                                )}
                            </span>
                        </label>
                    </li>
                ))}
            </ul>
        </FullScreenEditor>
    );
}
