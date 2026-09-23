import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FilterSheet from './FilterSheet';
import type { FilterSheetSection } from './FilterSheet';

function sections(): FilterSheetSection[] {
    return [
        { id: 'dates', label: 'Dates', group: 'Dates', summary: 'Any' },
        {
            id: 'profile-selector',
            label: 'Search profile',
            group: 'Search profile',
            groupVariant: 'boxed',
            summary: '',
            customRow: <button data-testid="my-selector">Custom</button>,
        },
        { id: 'area', label: 'Area', group: 'Search profile', groupVariant: 'boxed', summary: 'Barcelona' },
        { id: 'people', label: 'People', group: 'Other filters', summary: 'Any' },
    ];
}

describe('FilterSheet grouping', () => {
    it('boxes the flagged group and drops plain-group headings', () => {
        render(
            <FilterSheet
                open
                onClose={vi.fn()}
                sections={sections()}
                activeFilterCount={0}
                matchingEventCount={5}
            />,
        );
        // Plain groups (Dates, Other filters) render no heading now.
        expect(screen.queryByText('Other filters')).toBeNull();
        // "Dates" appears once, as the row label only (no group heading).
        expect(screen.getAllByText('Dates')).toHaveLength(1);
        // The boxed "Search profile" group renders its label, uppercased.
        const profileLabel = screen.getByText('Search profile');
        expect(profileLabel).toHaveClass('uppercase');
    });

    it('renders a customRow instead of a navigable button', () => {
        render(
            <FilterSheet
                open
                onClose={vi.fn()}
                sections={sections()}
                activeFilterCount={0}
                matchingEventCount={5}
            />,
        );
        expect(screen.getByTestId('my-selector')).toBeInTheDocument();
        // The standard nav rows still render their summaries.
        expect(screen.getByTestId('filter-sheet-summary-area')).toHaveTextContent('Barcelona');
    });

    it('keeps reset and clear actions together in the footer', async () => {
        const onReset = vi.fn();
        const onClearAll = vi.fn();
        const user = userEvent.setup();
        render(
            <FilterSheet
                open
                onClose={vi.fn()}
                sections={sections()}
                onReset={onReset}
                onClearAll={onClearAll}
                activeFilterCount={2}
                matchingEventCount={5}
            />,
        );

        const reset = screen.getByTestId('filter-sheet-reset');
        const clear = screen.getByTestId('filter-sheet-clear-all');
        expect(reset.parentElement).toBe(clear.parentElement);

        await user.click(reset);
        await user.click(clear);
        expect(onReset).toHaveBeenCalledOnce();
        expect(onClearAll).toHaveBeenCalledOnce();
    });
});
