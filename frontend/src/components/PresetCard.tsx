/**
 * PresetCard — card UI for area presets in the "YOUR AREAS" section.
 * Displays label + sublabel with active/inactive styling.
 */

export interface PresetCardProps {
    label: string;
    subLabel: string;
    isActive: boolean;
    onClick: () => void;
    testId?: string;
    preview?: React.ReactNode;
}

export default function PresetCard({ label, subLabel, isActive, onClick, testId, preview }: PresetCardProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`flex h-[74px] w-[250px] shrink-0 items-center gap-2 rounded-card border px-3 py-2 text-left transition ${isActive
                ? 'border-action bg-blue-50 text-action'
                : 'border-card-line bg-surface text-ink hover:border-action/40'}`}
            aria-pressed={isActive}
            data-testid={testId}
        >
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{label}</span>
                <span className="mt-1 block truncate text-[10px] leading-tight text-ink-soft">
                    {subLabel}
                </span>
            </span>
            {preview}
        </button>
    );
}
