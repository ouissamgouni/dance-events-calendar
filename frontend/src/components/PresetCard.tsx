/**
 * PresetCard — card UI for area presets in the "YOUR AREAS" section.
 * Displays label + sublabel with active/inactive styling.
 */

export interface PresetCardProps {
    /** Primary label (e.g., area name). */
    label: string;
    /** Secondary label (e.g., "From your 'Default' profile"). */
    subLabel: string;
    /** Whether this card represents the currently selected area. */
    isActive: boolean;
    /** Callback when the card is clicked. */
    onClick: () => void;
    /** Optional test ID for automated testing. */
    testId?: string;
}

export default function PresetCard({ label, subLabel, isActive, onClick, testId }: PresetCardProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`inline-flex max-w-xs flex-col items-start rounded-md border px-3 py-2.5 text-left transition ${isActive
                ? 'border-action bg-action text-white'
                : 'border-action/30 bg-action/5 text-ink hover:bg-action/10'}`}
            aria-pressed={isActive}
            data-testid={testId}
        >
            <span className="max-w-full truncate text-sm font-medium">{label}</span>
            <span className={`max-w-full truncate text-xs leading-tight ${isActive ? 'text-white/80' : 'text-ink-soft'}`}>
                {subLabel}
            </span>
        </button>
    );
}
