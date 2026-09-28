import { Lock, UserRoundCheck, Users } from 'lucide-react';
import { useState } from 'react';
import type { PlanAudience } from '../../types';
import BottomSheet from '../BottomSheet';

interface Props {
    busy: boolean;
    error: string | null;
    onConfirm: (audience: PlanAudience) => void;
    onNotNow: () => void;
}

const OPTIONS: Array<{
    value: PlanAudience;
    label: string;
    description: string;
    Icon: typeof Users;
}> = [
        {
            value: 'followers',
            label: 'Followers attending',
            description: 'People who follow you and are going to this event.',
            Icon: Users,
        },
        {
            value: 'friends',
            label: 'Friends attending',
            description: 'Mutual followers who are going to this event.',
            Icon: UserRoundCheck,
        },
        {
            value: 'private',
            label: 'Only me',
            description: 'Keep your session choices private.',
            Icon: Lock,
        },
    ];

export function PlanAudienceOptions({
    busy,
    value,
    onChange,
}: {
    busy: boolean;
    value: PlanAudience | null;
    onChange: (audience: PlanAudience) => void;
}) {
    return (
        <div role="radiogroup" aria-label="Plan activity audience" className="space-y-2">
            {OPTIONS.map(({ value: option, label, description, Icon }) => {
                const selected = value === option;
                return (
                    <button key={option} type="button" role="radio" aria-checked={selected} disabled={busy} onClick={() => onChange(option)} className={`flex w-full items-start gap-3 rounded-field border p-3 text-left disabled:opacity-50 ${selected ? 'border-action bg-action/10' : 'border-line bg-surface'}`}>
                        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${selected ? 'text-action' : 'text-ink-soft'}`} aria-hidden="true" />
                        <span><span className="block text-sm font-semibold text-ink">{label}</span><span className="mt-1 block text-xs leading-5 text-ink-soft">{description}</span></span>
                    </button>
                );
            })}
        </div>
    );
}

export default function PlanAudienceSheet({ busy, error, onConfirm, onNotNow }: Props) {
    const [value, setValue] = useState<PlanAudience>('followers');
    return (
        <BottomSheet
            title="Share your plan activity?"
            onClose={busy ? () => undefined : onNotNow}
            footer={(
                <div className="flex gap-2">
                    <button type="button" disabled={busy} onClick={onNotNow} className="min-h-11 flex-1 rounded-field border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50">Not now</button>
                    <button type="button" disabled={busy} onClick={() => onConfirm(value)} className="min-h-11 flex-1 rounded-field bg-action px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : 'Continue'}</button>
                </div>
            )}
        >
            <p className="mb-4 text-sm leading-6 text-ink-soft">Let people attending know which sessions you add. You can change this from My Plan.</p>
            <PlanAudienceOptions busy={busy} value={value} onChange={setValue} />
            {error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null}
        </BottomSheet>
    );
}
