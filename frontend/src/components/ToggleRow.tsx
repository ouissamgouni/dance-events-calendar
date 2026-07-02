/** Square switch row shared by notification/preference toggle lists. */
export default function ToggleRow({
    label,
    description,
    checked,
    busy,
    disabled,
    onChange,
}: {
    label: string;
    description: string;
    checked: boolean;
    busy: boolean;
    disabled?: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
                <div className="text-sm font-medium text-slate-800">{label}</div>
                <p className="text-xs text-slate-500 mt-0.5">{description}</p>
            </div>
            <button
                type="button"
                role="switch"
                aria-checked={checked}
                aria-label={label}
                disabled={busy || disabled}
                onClick={() => onChange(!checked)}
                className={
                    // eslint-disable-next-line no-restricted-syntax -- circular toggle switch is an allowed exception
                    'relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-60 ' +
                    (checked ? 'bg-blue-500' : 'bg-slate-300')
                }
            >
                <span
                    className={
                        // eslint-disable-next-line no-restricted-syntax -- circular toggle thumb is an allowed exception
                        'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ' +
                        (checked ? 'translate-x-5' : 'translate-x-0.5')
                    }
                />
            </button>
        </div>
    );
}
