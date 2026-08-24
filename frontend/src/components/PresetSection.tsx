/**
 * PresetSection — reusable section header + content wrapper for area presets.
 * Used by AreaEditor to display "YOUR AREAS" and "REGIONS" sections.
 */

export interface PresetSectionProps {
    /** Section title (e.g., "YOUR AREAS", "REGIONS"). */
    title: string;
    /** Content to render below the header. */
    children: React.ReactNode;
}

export default function PresetSection({ title, children }: PresetSectionProps) {
    return (
        <div className="flex flex-col gap-3">
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-ink-soft">{title}</h3>
            <div className="flex flex-wrap gap-2">
                {children}
            </div>
        </div>
    );
}
