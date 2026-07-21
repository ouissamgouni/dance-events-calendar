/**
 * Formats an ISO 4217 currency code (e.g. "EUR", "USD", "GBP") as its
 * narrow currency sign (e.g. "€", "$", "£") for compact display in price
 * badges. Falls back to the raw code if the runtime can't resolve a symbol
 * for it (e.g. an unrecognized/invalid code).
 */
export function currencySymbol(code: string | null | undefined): string {
    if (!code) return '';
    try {
        const formatter = new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: code,
            currencyDisplay: 'narrowSymbol',
        });
        const symbol = formatter.formatToParts(0).find((p) => p.type === 'currency')?.value;
        return symbol ?? code;
    } catch {
        return code;
    }
}
