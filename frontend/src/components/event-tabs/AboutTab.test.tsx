import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarEvent } from '../../types';
import AboutTab from './AboutTab';

vi.mock('../../context/FeatureFlagsContext', () => ({
    useFeatureFlags: () => ({ showPrices: true }),
}));

vi.mock('../ExpandableDescription', () => ({
    default: () => <div data-testid="about-description" />,
}));

vi.mock('../TagBadges', () => ({
    default: () => <div data-testid="category-tags" />,
}));

vi.mock('../event-summary/LinksRow', () => ({
    default: () => <div data-testid="event-links" />,
}));

vi.mock('../EventSeriesLink', () => ({
    default: () => <div data-testid="event-series" />,
}));

vi.mock('../EventPromoCodes', () => ({
    EventPromoCodes: () => <div data-testid="promo-codes" />,
}));

function detailEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        event_id: 'event-1',
        description: 'First line\n🎉 Second line',
        tags: [{ id: 1, label: 'Salsa' }],
        links: [{ url: 'https://example.com/tickets', label: 'Tickets' }],
        price_is_free: false,
        price_min: 12,
        price_max: 15,
        price_currency: 'EUR',
        ...overrides,
    } as CalendarEvent;
}

describe('AboutTab', () => {
    it('renders Details content in the requested order', () => {
        render(<AboutTab event={detailEvent()} />);

        const content = [
            screen.getByRole('heading', { name: 'About' }),
            screen.getByRole('heading', { name: 'Categories' }),
            screen.getByTestId('event-links'),
            screen.getByTestId('event-series'),
            screen.getByRole('heading', { name: 'Price' }),
            screen.getByTestId('promo-codes'),
        ];

        content.slice(0, -1).forEach((element, index) => {
            expect(element.compareDocumentPosition(content[index + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        });
        expect(screen.queryByRole('heading', { name: 'Links' })).not.toBeInTheDocument();
    });

    it('omits empty About, Categories, Links, and Price cards', () => {
        render(<AboutTab event={detailEvent({
            description: null,
            tags: [],
            links: null,
            price_min: null,
            price_max: null,
            price_currency: null,
        })} />);

        expect(screen.queryByRole('heading', { name: 'About' })).not.toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Categories' })).not.toBeInTheDocument();
        expect(screen.queryByTestId('event-links')).not.toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Price' })).not.toBeInTheDocument();
    });
});
