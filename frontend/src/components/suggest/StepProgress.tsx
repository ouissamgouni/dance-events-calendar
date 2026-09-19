import { Fragment } from 'react';

interface Props {
    step: number;
    total: number;
    /** Announced with the step number; the dots themselves are decorative. */
    label: string;
}

/* Progress dots are genuinely circular status indicators. */
const dotCls = (active: boolean) =>
    `shrink-0 rounded-full ${active ? 'h-3 w-3 bg-action' : 'h-1.5 w-1.5 bg-ink-soft'}`;

/** `Step 1 of 3` caption above a connected dot track. */
export default function StepProgress({ step, total, label }: Props) {
    const steps = Array.from({ length: total }, (_, i) => i + 1);

    return (
        <div
            className="flex flex-col items-center gap-2 pb-1"
            role="group"
            aria-label={`Step ${step} of ${total}: ${label}`}
        >
            <span className="text-xs text-ink-soft">
                Step {step} of {total}
            </span>
            <div className="flex w-36 items-center" aria-hidden="true">
                {steps.map((i) => (
                    <Fragment key={i}>
                        {i > 1 ? <span className="h-0.5 flex-1 bg-action/25" /> : null}
                        <span className={dotCls(i === step)} />
                    </Fragment>
                ))}
            </div>
        </div>
    );
}
