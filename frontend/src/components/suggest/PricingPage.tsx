import { useState } from 'react';
import SubPage from './SubPage';
import {
    btnPrimary,
    errorCls,
    fieldLabelCls,
    helpCls,
    inputCls,
    sectionLabelCls,
    type PatchState,
    type PriceMode,
    type SuggestFormState,
} from './formState';

interface Props {
    state: SuggestFormState;
    patch: PatchState;
    onClose: () => void;
}

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'] as const;

const MODES: { key: PriceMode; label: string; hint: string }[] = [
    { key: 'none', label: 'No pricing', hint: "Don't show a price for this event." },
    { key: 'free', label: 'Free event', hint: 'Shown as free to attend.' },
    { key: 'paid', label: 'Paid event', hint: 'Give a price or a price range.' },
];

/** Full-screen pricing editor. Confirms with Done, never Submit Event. */
export default function PricingPage({ state, patch, onClose }: Props) {
    const [touched, setTouched] = useState(false);

    const min = Number(state.priceMin);
    const max = Number(state.priceMax);
    const rangeInvalid =
        state.priceMode === 'paid' &&
        state.priceMin !== '' &&
        state.priceMax !== '' &&
        Number.isFinite(min) &&
        Number.isFinite(max) &&
        max < min;
    const missingPrice = state.priceMode === 'paid' && state.priceMin === '' && state.priceMax === '';
    const error = rangeInvalid
        ? 'The maximum price must be at least the minimum.'
        : touched && missingPrice
            ? 'Enter at least one price, or choose Free event.'
            : null;

    const done = () => {
        setTouched(true);
        if (rangeInvalid || missingPrice) return;
        onClose();
    };

    return (
        <SubPage
            title="Pricing"
            onBack={onClose}
            footer={
                <button type="button" className={btnPrimary} onClick={done} disabled={rangeInvalid}>
                    Done
                </button>
            }
        >
            <fieldset>
                <legend className={sectionLabelCls}>Pricing</legend>
                <div className="space-y-2">
                    {MODES.map((m) => (
                        <label
                            key={m.key}
                            className="flex min-h-12 w-full items-start gap-3 rounded-field border border-line bg-surface px-4 py-3"
                        >
                            <input
                                type="radio"
                                name="price-mode"
                                className="mt-1"
                                checked={state.priceMode === m.key}
                                onChange={() => patch({ priceMode: m.key })}
                            />
                            <span className="min-w-0">
                                <span className="block text-sm text-ink">{m.label}</span>
                                <span className="block text-xs text-ink-soft">{m.hint}</span>
                            </span>
                        </label>
                    ))}
                </div>
            </fieldset>

            {state.priceMode === 'paid' ? (
                <div className="mt-6 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className={fieldLabelCls} htmlFor="price-min">
                                Minimum
                            </label>
                            <input
                                id="price-min"
                                type="number"
                                inputMode="decimal"
                                min={0}
                                step="0.01"
                                value={state.priceMin}
                                onChange={(e) => patch({ priceMin: e.target.value })}
                                placeholder="0"
                                className={inputCls}
                            />
                        </div>
                        <div>
                            <label className={fieldLabelCls} htmlFor="price-max">
                                Maximum
                            </label>
                            <input
                                id="price-max"
                                type="number"
                                inputMode="decimal"
                                min={0}
                                step="0.01"
                                value={state.priceMax}
                                onChange={(e) => patch({ priceMax: e.target.value })}
                                placeholder="0"
                                className={inputCls}
                            />
                        </div>
                    </div>
                    <div>
                        <label className={fieldLabelCls} htmlFor="price-currency">
                            Currency
                        </label>
                        <select
                            id="price-currency"
                            value={state.priceCurrency}
                            onChange={(e) => patch({ priceCurrency: e.target.value })}
                            className={inputCls}
                        >
                            {CURRENCIES.map((c) => (
                                <option key={c} value={c}>
                                    {c}
                                </option>
                            ))}
                        </select>
                    </div>
                    <p className={helpCls}>Leave the maximum empty for a single fixed price.</p>
                </div>
            ) : null}

            {error ? <p className={errorCls}>{error}</p> : null}
        </SubPage>
    );
}
