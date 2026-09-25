import type { CalendarEvent } from '../types';
import { currencySymbol } from './currency';

type EventPrice = Pick<CalendarEvent, 'price_is_free' | 'price_min' | 'price_max' | 'price_currency'>;

interface FormatEventPriceOptions {
    currencyDisplay?: 'symbol' | 'code';
    repeatCurrency?: boolean;
}

export function formatEventPrice(
    event: EventPrice,
    { currencyDisplay = 'symbol', repeatCurrency = false }: FormatEventPriceOptions = {},
): string | null {
    if (event.price_is_free) return 'Free';
    if (event.price_min == null || !event.price_currency) return null;

    const currency = currencyDisplay === 'code'
        ? `${event.price_currency} `
        : currencySymbol(event.price_currency);
    const minimum = `${currency}${event.price_min}`;

    if (event.price_max == null) return `${minimum}+`;
    if (event.price_max !== event.price_min) {
        const maximum = repeatCurrency ? `${currency}${event.price_max}` : event.price_max;
        return `${minimum}–${maximum}`;
    }
    return minimum;
}
