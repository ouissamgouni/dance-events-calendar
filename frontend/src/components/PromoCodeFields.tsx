import {
    fieldLabelCls,
    inputCls,
    isLinkFilled,
    isUrlValid,
    scrollIntoViewOnFocus,
} from './suggest/formState';

export interface PromoCodeFormValue {
    code: string;
    sourceUrl: string;
    description: string;
    expiresAt?: string;
}

interface Props {
    value: PromoCodeFormValue;
    onChange: (patch: Partial<PromoCodeFormValue>) => void;
    idPrefix?: string;
    showExpiry?: boolean;
}

export function promoCodeFormError(value: PromoCodeFormValue, requireCode = false): string | null {
    if (requireCode && !value.code.trim()) return 'Promo code is required.';
    if (isLinkFilled(value.sourceUrl) && !isUrlValid(value.sourceUrl)) {
        return 'Enter a valid URL (including https://).';
    }
    return null;
}

export default function PromoCodeFields({
    value,
    onChange,
    idPrefix = 'promo',
    showExpiry = false,
}: Props) {
    return (
        <>
            <label className={fieldLabelCls} htmlFor={`${idPrefix}-code`}>
                Promo code
            </label>
            <input
                id={`${idPrefix}-code`}
                type="text"
                autoCapitalize="characters"
                value={value.code}
                maxLength={64}
                onChange={(event) => onChange({ code: event.target.value })}
                onFocus={scrollIntoViewOnFocus}
                placeholder="e.g. SALSA10"
                className={inputCls}
            />

            <label className={`${fieldLabelCls} mt-4`} htmlFor={`${idPrefix}-url`}>
                Where you found it
            </label>
            <input
                id={`${idPrefix}-url`}
                type="url"
                inputMode="url"
                value={value.sourceUrl}
                maxLength={500}
                onChange={(event) => onChange({ sourceUrl: event.target.value })}
                onFocus={scrollIntoViewOnFocus}
                placeholder="https://"
                className={inputCls}
            />

            <label className={`${fieldLabelCls} mt-4`} htmlFor={`${idPrefix}-description`}>
                Details
            </label>
            <textarea
                id={`${idPrefix}-description`}
                value={value.description}
                maxLength={200}
                onChange={(event) => onChange({ description: event.target.value })}
                onFocus={scrollIntoViewOnFocus}
                rows={6}
                placeholder="What does the code get you, and who can use it?"
                className={inputCls}
            />

            {showExpiry && (
                <>
                    <label className={`${fieldLabelCls} mt-4`} htmlFor={`${idPrefix}-expires`}>
                        Expires
                    </label>
                    <input
                        id={`${idPrefix}-expires`}
                        type="date"
                        value={value.expiresAt ?? ''}
                        onChange={(event) => onChange({ expiresAt: event.target.value })}
                        className={inputCls}
                    />
                </>
            )}
        </>
    );
}
