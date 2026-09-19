import { useState } from 'react';
import { Banknote, Mail, Percent, User } from 'lucide-react';
import { Switch } from '../ToggleRow';
import Row from './Row';
import PricingPage from './PricingPage';
import PromoCodePage from './PromoCodePage';
import {
    chipCls,
    fieldErrorCls,
    inputCls,
    isLinkFilled,
    scrollIntoViewOnFocus,
    sectionLabelCls,
    type GoingAudience,
    type PatchState,
    type SuggestFormState,
} from './formState';
import type { FieldError } from './validation';

interface Props {
    state: SuggestFormState;
    patch: PatchState;
    error: FieldError | null;
    signedIn: boolean;
    /** Lets the shell hide its header and footer while a sub-page is open. */
    onSubPageChange: (open: boolean) => void;
}

const AUDIENCES: GoingAudience[] = ['friends', 'public', 'private'];

const AUDIENCE_LABELS: Record<GoingAudience, string> = {
    friends: 'Friends',
    public: 'Everyone',
    private: 'Only me',
};

function priceSummary(state: SuggestFormState): string | undefined {
    if (state.priceMode === 'none') return undefined;
    if (state.priceMode === 'free') return 'Free event';
    const { priceMin, priceMax, priceCurrency } = state;
    if (priceMin && priceMax && priceMin !== priceMax) return `${priceMin}–${priceMax} ${priceCurrency}`;
    const single = priceMin || priceMax;
    return single ? `${single} ${priceCurrency}` : 'Paid event';
}

function promoSummary(state: SuggestFormState): string | undefined {
    if (state.promoCode.trim()) return state.promoCode.trim();
    if (state.promoDescription.trim() || isLinkFilled(state.promoSourceUrl)) return 'Promo details added';
    return undefined;
}

export default function Step3Publish({ state, patch, error, signedIn, onSubPageChange }: Props) {
    const [page, setPage] = useState<'none' | 'pricing' | 'promo'>('none');

    const errorFor = (field: FieldError['field']) => (error?.field === field ? error.message : null);

    const open = (next: 'pricing' | 'promo') => {
        setPage(next);
        onSubPageChange(true);
    };
    const close = () => {
        setPage('none');
        onSubPageChange(false);
    };

    if (page === 'pricing') {
        return <PricingPage state={state} patch={patch} onClose={close} />;
    }
    if (page === 'promo') {
        return <PromoCodePage state={state} patch={patch} onDone={close} />;
    }

    return (
        <div className="space-y-3">
            <div>
                <Row
                    id="suggest-pricing"
                    icon={Banknote}
                    label="Pricing"
                    value={priceSummary(state)}
                    placeholder="No pricing"
                    invalid={Boolean(errorFor('pricing'))}
                    describedBy={errorFor('pricing') ? 'suggest-pricing-error' : undefined}
                    onClick={() => open('pricing')}
                />
                {errorFor('pricing') ? (
                    <p id="suggest-pricing-error" className={fieldErrorCls}>
                        {errorFor('pricing')}
                    </p>
                ) : null}
            </div>

            <div>
                <Row
                    id="suggest-promo"
                    icon={Percent}
                    label="Promo code"
                    value={promoSummary(state)}
                    placeholder="Add a promo code"
                    invalid={Boolean(errorFor('promo'))}
                    describedBy={errorFor('promo') ? 'suggest-promo-error' : undefined}
                    onClick={() => open('promo')}
                />
                {errorFor('promo') ? (
                    <p id="suggest-promo-error" className={fieldErrorCls}>
                        {errorFor('promo')}
                    </p>
                ) : null}
            </div>

            {signedIn ? (
                <div className="space-y-3 pt-3">
                    <div className="flex min-h-12 items-center gap-3 rounded-field border border-line bg-surface px-4 py-2">
                        <span className="text-sm text-ink">I&apos;m going</span>
                        <span className="ml-auto">
                            <Switch
                                label="I'm going"
                                checked={state.going}
                                onChange={(going) => patch({ going })}
                            />
                        </span>
                    </div>
                    {/* Visibility only means something when attendance is on. */}
                    {state.going ? (
                        <div>
                            <span className={sectionLabelCls}>Who can see it</span>
                            <div className="flex flex-wrap gap-2">
                                {AUDIENCES.map((option) => (
                                    <button
                                        key={option}
                                        type="button"
                                        aria-pressed={state.goingAudience === option}
                                        onClick={() => patch({ goingAudience: option })}
                                        className={chipCls(state.goingAudience === option)}
                                    >
                                        {AUDIENCE_LABELS[option]}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : null}
                </div>
            ) : (
                <p className="rounded-field border border-line bg-canvas p-3 text-sm text-ink-soft">
                    Sign in to mark yourself as going when this event is published.
                </p>
            )}

            <div className="space-y-3 pt-3">
                <div className="relative">
                    <User
                        size={18}
                        className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted"
                        aria-hidden="true"
                    />
                    <input
                        aria-label="Your name"
                        type="text"
                        value={state.submitterName}
                        onChange={(e) => patch({ submitterName: e.target.value })}
                        onFocus={scrollIntoViewOnFocus}
                        placeholder="Your name"
                        className={`${inputCls} pl-11`}
                    />
                </div>
                <div className="relative">
                    <Mail
                        size={18}
                        className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted"
                        aria-hidden="true"
                    />
                    <input
                        aria-label="Your email"
                        type="email"
                        inputMode="email"
                        value={state.submitterEmail}
                        onChange={(e) => patch({ submitterEmail: e.target.value })}
                        onFocus={scrollIntoViewOnFocus}
                        placeholder="Your email"
                        className={`${inputCls} pl-11`}
                    />
                </div>
            </div>
        </div>
    );
}
