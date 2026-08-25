import { useRef } from 'react';
import type { PreferredAreaPayload } from '../../api';
import SquareAreaMapEditor from '../SquareAreaMapEditor';
import { bboxSearchArea, toPreferredArea } from '../../utils/searchArea';

interface Props {
    area: PreferredAreaPayload;
    alertsEnabled: boolean;
    nameManuallyEdited?: boolean;
    onAreaChange: (area: PreferredAreaPayload) => void;
    onAlertsChange: (enabled: boolean) => void;
    onNameManuallyEdited?: () => void;
    onBack: () => void;
    onContinue: () => void;
    continueLabel?: string;
    title?: string;
    showAlerts?: boolean;
}

const MINIMUM_SIDE_KM = 1000;

export default function OnboardingAreaEditor({
    area,
    alertsEnabled,
    nameManuallyEdited = false,
    onAreaChange,
    onAlertsChange,
    onNameManuallyEdited,
    onBack,
    onContinue,
    continueLabel = 'Continue',
    title = 'International area',
    showAlerts = true,
}: Props) {
    const nameInputRef = useRef<HTMLInputElement | null>(null);
    const searchArea = bboxSearchArea(area, area.label === 'Custom area' ? 'custom' : 'preset');

    const focusName = () => {
        window.requestAnimationFrame(() => {
            nameInputRef.current?.focus();
            nameInputRef.current?.select();
        });
    };

    const updateName = (value: string) => {
        onNameManuallyEdited?.();
        onAreaChange({ ...area, label: value.slice(0, 30) });
    };

    const normalizeName = () => {
        if (area.label.trim()) return;
        onAreaChange({ ...area, label: 'Custom area' });
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="relative flex min-h-12 items-center justify-center px-14">
                <button type="button" onClick={onBack} aria-label="Back" className="absolute left-2 top-0 min-h-11 min-w-11 text-2xl text-ink">‹</button>
                <h1 className="truncate text-base font-bold text-ink">{title}</h1>
            </div>

            <SquareAreaMapEditor
                area={searchArea}
                onChange={(next) => onAreaChange(toPreferredArea(next))}
                minimumSideKm={MINIMUM_SIDE_KM}
                preserveLabel={nameManuallyEdited}
                showInlineUseAction
                onInlineUse={focusName}
            />

            <p className="px-4 pt-3 text-xs text-ink-soft">Move, zoom or resize to customize your area.</p>
            <div className="flex-1 bg-surface px-4 pb-3 pt-4">
                <label htmlFor="onboarding-area-name" className="flex min-h-11 items-center gap-3">
                    <span className="shrink-0 text-sm font-semibold text-ink">Name</span>
                    <span className="relative min-w-0 flex-1">
                        <input
                            ref={nameInputRef}
                            id="onboarding-area-name"
                            aria-label="Name"
                            value={area.label}
                            maxLength={30}
                            onChange={(event) => updateName(event.target.value)}
                            onBlur={normalizeName}
                            className="min-h-11 w-full border border-line bg-surface px-3 pr-10 text-sm font-semibold text-ink focus:border-action focus:outline-none"
                        />
                        <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-action">✎</span>
                    </span>
                </label>
                {showAlerts && (
                    <label className="mt-3 flex min-h-12 items-center justify-between border-t border-line py-3 text-sm font-semibold text-ink">
                        <span>New event alerts</span>
                        <input type="checkbox" checked={alertsEnabled} onChange={(event) => onAlertsChange(event.target.checked)} className="h-5 w-5 accent-action" />
                    </label>
                )}
            </div>

            <div className="sticky bottom-0 z-[700] border-t border-line bg-surface px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3">
                <button type="button" onClick={onContinue} className="min-h-12 w-full bg-action px-4 text-sm font-semibold text-white hover:bg-action-strong">{continueLabel}</button>
            </div>
        </div>
    );
}
