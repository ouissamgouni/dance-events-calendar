/**
 * RegionPill — pill/button UI for area region presets in the "REGIONS" section.
 * Displays label with active/inactive styling matching the screenshot design.
 */

export interface RegionPillProps {
    /** Label text (e.g., "Europe", "N. America", "Anywhere"). */
    label: string;
    /** Whether this pill represents the currently selected area. */
    isActive: boolean;
    /** Callback when the pill is clicked. */
    onClick: () => void;
    /** Optional test ID for automated testing. */
    testId?: string;
}

export default function RegionPill({ label, isActive, onClick, testId }: RegionPillProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition ${isActive
                ? 'border-action bg-surface text-action'
                : 'border-line bg-surface text-ink hover:border-ink/40'}`}
            aria-pressed={isActive}
            data-testid={testId}
        >
            {label}
        </button>
    );
}
