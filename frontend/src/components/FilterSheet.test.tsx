import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
