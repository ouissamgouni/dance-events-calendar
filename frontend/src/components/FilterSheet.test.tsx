import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

describe('FilterSheet mobile sizing', () => {
    const editorSections = (): FilterSheetSection[] => [
        { id: 'reach', label: 'Event reach', summary: 'Any', size: 'compact', render: () => <div>reach editor</div> },
        { id: 'area', label: 'Area', summary: 'Any', render: () => <div>area editor</div> },
    ];

    it('hugs content for compact editors and fills the sheet for full ones', async () => {
        const user = userEvent.setup();
        render(
            <FilterSheet open onClose={vi.fn()} sections={editorSections()} activeFilterCount={0} matchingEventCount={5} />,
        );
        const panel = screen.getByTestId('filter-sheet-panel');
        expect(panel).not.toHaveClass('filter-sheet-panel--full');

        await user.click(screen.getByTestId('filter-sheet-row-reach'));
        expect(screen.getByText('reach editor')).toBeInTheDocument();
        expect(screen.queryByTestId('filter-sheet-row-area')).toBeNull();
        expect(panel).not.toHaveClass('filter-sheet-panel--full');

        await user.click(screen.getByTestId('full-screen-editor-back'));
        await user.click(screen.getByTestId('filter-sheet-row-area'));
        expect(panel).toHaveClass('filter-sheet-panel--full');
    });

    it('closes on a downward swipe from the handle', () => {
        const onClose = vi.fn();
        render(
            <FilterSheet open onClose={onClose} sections={editorSections()} activeFilterCount={0} matchingEventCount={5} />,
        );
        const handle = screen.getByTestId('filter-sheet-handle');
        fireEvent.pointerDown(handle, { clientY: 100 });
        fireEvent.pointerUp(handle, { clientY: 110 });
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.pointerDown(handle, { clientY: 100 });
        fireEvent.pointerUp(handle, { clientY: 200 });
        expect(onClose).toHaveBeenCalledOnce();
    });
});
