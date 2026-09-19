import SubPage from './SubPage';
import {
    btnPrimary,
    errorCls,
    fieldLabelCls,
    inputCls,
    isLinkFilled,
    isUrlValid,
    scrollIntoViewOnFocus,
    type PatchState,
    type SuggestFormState,
} from './formState';

interface Props {
    state: SuggestFormState;
    patch: PatchState;
    /** Closes the editor and returns to Step 3. This must never submit. */
    onDone: () => void;
}

/**
 * Full-screen sub-page for the promo code. Its only call to action is `Done`,
 * which returns to Step 3 — the event is submitted from Step 3 and nowhere
 * else, so a long promo description can never be mistaken for a final confirm.
 */
export default function PromoCodePage({ state, patch, onDone }: Props) {
    const urlError =
        isLinkFilled(state.promoSourceUrl) && !isUrlValid(state.promoSourceUrl)
            ? 'Enter a valid URL (including https://).'
            : null;

    return (
        <SubPage
            title="Promo code"
            onBack={onDone}
            footer={
                <button type="button" className={btnPrimary} onClick={onDone} disabled={Boolean(urlError)}>
                    Done
                </button>
            }
        >
            <label className={fieldLabelCls} htmlFor="promo-code">
                Promo code
            </label>
            <input
                id="promo-code"
                type="text"
                autoCapitalize="characters"
                value={state.promoCode}
                onChange={(e) => patch({ promoCode: e.target.value })}
                onFocus={scrollIntoViewOnFocus}
                placeholder="e.g. SALSA10"
                className={inputCls}
            />

            <label className={`${fieldLabelCls} mt-4`} htmlFor="promo-url">
                Where you found it
            </label>
            <input
                id="promo-url"
                type="url"
                inputMode="url"
                value={state.promoSourceUrl}
                onChange={(e) => patch({ promoSourceUrl: e.target.value })}
                onFocus={scrollIntoViewOnFocus}
                placeholder="https://"
                className={inputCls}
            />

            <label className={`${fieldLabelCls} mt-4`} htmlFor="promo-description">
                Details
            </label>
            <textarea
                id="promo-description"
                value={state.promoDescription}
                onChange={(e) => patch({ promoDescription: e.target.value })}
                onFocus={scrollIntoViewOnFocus}
                rows={6}
                placeholder="What does the code get you, and who can use it?"
                className={inputCls}
            />

            {urlError ? <p className={errorCls}>{urlError}</p> : null}
        </SubPage>
    );
}
