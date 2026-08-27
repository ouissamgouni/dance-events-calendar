import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { act } from 'react';
import userEvent from '@testing-library/user-event';
import SummaryBar, { type SummaryBarProps } from './SummaryBar';
import type { TagGroup } from '../types';

// A controllable ResizeObserver so tests can drive the SummaryBar's
// width-based overflow collapse. The default jsdom stub in test/setup.ts
// never fires, which leaves the bar in 'full' mode — fine for the toggle /
// area-chip tests but useless for the collapse tests.
let lastResizeCallback: ResizeObserverCallback | null = null;
let observedEl: Element | null = null;

class ControllableResizeObserver {
    constructor(cb: ResizeObserverCallback) {
        lastResizeCallback = cb;
    }
    observe(el: Element) {
        observedEl = el;
    }
    unobserve() { }
    disconnect() { }
}

function setBarWidth(width: number) {
    if (!lastResizeCallback || !observedEl) return;
    act(() => {
        lastResizeCallback!(
            [{ contentRect: { width } } as ResizeObserverEntry],
            {} as ResizeObserver,
        );
    });
}

const DANCE_GROUP = {
    id: 1,
    slug: 'dance-style',
    label: 'Dance',
    color: '#2563eb',
    allow_multiple: true,
    tags: [
        { id: 10, label: 'Salsa', color: '#2563eb' },
        { id: 11, label: 'Bachata', color: '#16a34a' },
    ],
} as unknown as TagGroup;

const REACH_GROUP = {
    id: 2,
    slug: 'reach',
    label: 'Event reach',
    color: '#7c3aed',
    allow_multiple: true,
    tags: [
        { id: 20, label: 'Local', color: '#7c3aed' },
        { id: 21, label: 'International', color: '#7c3aed' },
    ],
} as unknown as TagGroup;

const FORMAT_GROUP = {
    id: 3,
    slug: 'format',
    label: 'Format',
    color: '#0891b2',
    allow_multiple: true,
    tags: [{ id: 30, label: 'Party', color: '#0891b2' }],
} as unknown as TagGroup;

const TAG_GROUPS: TagGroup[] = [DANCE_GROUP, REACH_GROUP, FORMAT_GROUP];

function baseProps(overrides: Partial<SummaryBarProps> = {}): SummaryBarProps {
    return {
        totalCount: 12,
        visibleCount: 12,
        startDate: '2025-01-01',
        endDate: '2025-01-31',
        areaLabel: 'Europe & nearby',
        areaKind: 'user',
        areaIsDefault: false,
        activeTagIds: new Set<number>(),
        tagGroups: TAG_GROUPS,
        danceGroup: DANCE_GROUP,
        reachGroup: REACH_GROUP,
        reachFilter: 'any',
        interestSource: null,
        interestKind: 'any',
        interestUserHandles: [],
        interestMatch: 'any',
        ...overrides,
    };
}

// Force every measured pill (ghost copies + gear) to a fixed width so the
// collapse math is deterministic under jsdom (which otherwise reports 0).
const ORIGINAL_OFFSET_WIDTH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
function mockPillWidth(px: number) {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get() {
            return px;
        },
    });
}
function restorePillWidth() {
    if (ORIGINAL_OFFSET_WIDTH) {
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', ORIGINAL_OFFSET_WIDTH);
    } else {
        delete (HTMLElement.prototype as unknown as { offsetWidth?: number }).offsetWidth;
    }
}

describe('SummaryBar', () => {
    const OriginalResizeObserver = window.ResizeObserver;
    beforeEach(() => {
        lastResizeCallback = null;
        observedEl = null;
        window.ResizeObserver = ControllableResizeObserver as unknown as typeof ResizeObserver;
    });
    afterEach(() => {
        cleanup();
        restorePillWidth();
        window.ResizeObserver = OriginalResizeObserver;
    });

    it('renders the area chip with a pin icon and opens the area picker on click', async () => {
        const onEditArea = vi.fn();
        render(<SummaryBar {...baseProps({ onEditArea })} />);
        const chip = screen.getByTestId('summary-chip-area');
        expect(chip).toHaveTextContent('Europe & nearby');
        expect(chip.querySelector('img[src="/pin.png"]')).toBeInTheDocument();
        await userEvent.click(chip);
        expect(onEditArea).toHaveBeenCalledTimes(1);
    });

    it('shows a clear (×) affordance on the area chip only when not default', async () => {
        const onClearArea = vi.fn();
        const { rerender } = render(
            <SummaryBar {...baseProps({ areaIsDefault: false, onClearArea })} />,
        );
        const clearBtn = screen.getByRole('button', { name: 'Clear area filter' });
        await userEvent.click(clearBtn);
        expect(onClearArea).toHaveBeenCalledTimes(1);

        rerender(<SummaryBar {...baseProps({ areaIsDefault: true, onClearArea })} />);
        expect(screen.queryByRole('button', { name: 'Clear area filter' })).toBeNull();
    });

    it('renders the Dance chip with selected styles and deep-links to its editor', async () => {
        const onEditDance = vi.fn();
        const { rerender } = render(
            <SummaryBar {...baseProps({ activeTagIds: new Set([10]), onEditDance })} />,
        );
        const chip = screen.getByTestId('summary-chip-dance');
        expect(chip).toHaveTextContent('Salsa');
        await userEvent.click(chip);
        expect(onEditDance).toHaveBeenCalledTimes(1);

        // Multiple selections collapse to "First +N".
        rerender(<SummaryBar {...baseProps({ activeTagIds: new Set([10, 11]), onEditDance })} />);
        expect(screen.getByTestId('summary-chip-dance')).toHaveTextContent('Salsa +1');
    });

    it('renders the scalar Reach pill icon-only and deep-links', async () => {
        const onEditReach = vi.fn();
        const { rerender } = render(<SummaryBar {...baseProps({ reachFilter: 'any', onEditReach })} />);
        const reach = screen.getByTestId('summary-chip-reach');
        expect(reach).toHaveTextContent('');
        expect(reach.querySelector('img[src="/reach.png"]')).toBeInTheDocument();
        await userEvent.click(reach);
        expect(onEditReach).toHaveBeenCalledTimes(1);

        rerender(<SummaryBar {...baseProps({ reachFilter: 'regional_plus', onEditReach })} />);
        expect(screen.getByTestId('summary-chip-reach').querySelector('img[src="/nearby-reach.png"]')).toBeInTheDocument();

        rerender(<SummaryBar {...baseProps({ reachFilter: 'international', onEditReach })} />);
        expect(screen.getByTestId('summary-chip-reach').querySelector('img[src="/international-reach.png"]')).toBeInTheDocument();
    });

    it('renders the People WHO + STATUS pills and deep-links', async () => {
        const onEditPeople = vi.fn();
        const { rerender } = render(<SummaryBar {...baseProps()} />);
        expect(screen.queryByTestId('summary-chip-people')).toBeNull();

        // Scope-only (no handles) → WHO "Following" + STATUS "Both" (kind 'any').
        rerender(<SummaryBar {...baseProps({ onEditPeople, interestSource: 'follows' })} />);
        const scoped = screen.getByTestId('summary-chip-people');
        expect(scoped).toHaveTextContent('Following');
        expect(screen.getByTestId('summary-chip-people-status')).toHaveTextContent('Both');
        await userEvent.click(scoped);
        expect(onEditPeople).toHaveBeenCalledTimes(1);

        // Friends scope + Going status.
        rerender(<SummaryBar {...baseProps({ onEditPeople, interestSource: 'friends', interestKind: 'going' })} />);
        expect(screen.getByTestId('summary-chip-people')).toHaveTextContent('Friends');
        expect(screen.getByTestId('summary-chip-people-status')).toHaveTextContent('Going');

        // Explicit handles → WHO "N people" + STATUS.
        rerender(
            <SummaryBar {...baseProps({ onEditPeople, interestSource: 'follows', interestUserHandles: ['a', 'b', 'c'], interestKind: 'going' })} />,
        );
        expect(screen.getByTestId('summary-chip-people')).toHaveTextContent('3 people');
        expect(screen.getByTestId('summary-chip-people-status')).toHaveTextContent('Going');
    });

    it('folds selected non-primary groups into the "+X ⚙" control and opens the sheet', async () => {
        const onOpenFilters = vi.fn();
        // Dance is tag-backed, Reach is scalar, and Format folds → +1.
        render(
            <SummaryBar {...baseProps({ activeTagIds: new Set([10, 20, 30]), onOpenFilters })} />,
        );
        expect(screen.getByTestId('summary-chip-dance')).toBeInTheDocument();
        expect(screen.getByTestId('summary-chip-reach')).toBeInTheDocument();
        const gear = screen.getByTestId('summary-open-filters');
        expect(gear).toHaveTextContent('+1');
        await userEvent.click(gear);
        expect(onOpenFilters).toHaveBeenCalled();
    });

    it('shows just the gear (no +X) when nothing beyond visible pills is active', () => {
        render(<SummaryBar {...baseProps({ onOpenFilters: vi.fn() })} />);
        const gear = screen.getByTestId('summary-open-filters');
        expect(gear).not.toHaveTextContent('+');
    });

    it('hides pills right-to-left by priority as width shrinks, folding them into +X', () => {
        const onEditPeople = vi.fn();
        mockPillWidth(80);
        render(
            <SummaryBar
                {...baseProps({
                    // Dance + scalar Reach + People + Format (folded).
                    activeTagIds: new Set([10, 20, 30]),
                    onEditPeople,
                    interestSource: 'follows',
                    onOpenFilters: vi.fn(),
                })}
            />,
        );
        const bar = screen.getByTestId('summary-bar');
        expect(bar).toHaveAttribute('data-variant', 'single');
        expect(bar.querySelector('.flex-wrap')).toBeNull();
        // Wide: all primary pills fit (people splits into WHO + STATUS);
        // only Format folds → +1.
        setBarWidth(1000);
        expect(screen.getByTestId('summary-chip-period')).toBeInTheDocument();
        expect(screen.getByTestId('summary-chip-area')).toBeInTheDocument();
        expect(screen.getByTestId('summary-chip-dance')).toBeInTheDocument();
        expect(screen.getByTestId('summary-chip-reach')).toBeInTheDocument();
        expect(screen.getByTestId('summary-chip-people')).toBeInTheDocument();
        expect(screen.getByTestId('summary-chip-people-status')).toBeInTheDocument();
        expect(screen.getByTestId('summary-open-filters')).toHaveTextContent('+1');

        // Narrow: reserve gear (80+8) leaves room for only Date + Area; the
        // four lower-priority active pills fold in → +5 (Format + 4 hidden).
        setBarWidth(300);
        expect(screen.getByTestId('summary-chip-period')).toBeInTheDocument();
        expect(screen.getByTestId('summary-chip-area')).toBeInTheDocument();
        expect(screen.queryByTestId('summary-chip-dance')).toBeNull();
        expect(screen.queryByTestId('summary-chip-reach')).toBeNull();
        expect(screen.queryByTestId('summary-chip-people')).toBeNull();
        expect(screen.queryByTestId('summary-chip-people-status')).toBeNull();
        expect(screen.getByTestId('summary-open-filters')).toHaveTextContent('+5');
    });
});
