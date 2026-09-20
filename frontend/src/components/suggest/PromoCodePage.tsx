import SubPage from './SubPage';
import PromoCodeFields, { promoCodeFormError } from '../PromoCodeFields';
import {
    btnPrimary,
    errorCls,
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
    const value = {
        code: state.promoCode,
        sourceUrl: state.promoSourceUrl,
        description: state.promoDescription,
    };
    const urlError = promoCodeFormError(value);

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
            <PromoCodeFields
                value={value}
                onChange={(changes) => patch({
                    ...(changes.code !== undefined && { promoCode: changes.code }),
                    ...(changes.sourceUrl !== undefined && { promoSourceUrl: changes.sourceUrl }),
                    ...(changes.description !== undefined && { promoDescription: changes.description }),
                })}
            />

            {urlError ? <p className={errorCls}>{urlError}</p> : null}
        </SubPage>
    );
}
