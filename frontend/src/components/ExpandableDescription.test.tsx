import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExpandableDescription from './ExpandableDescription';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('ExpandableDescription', () => {
    it('renders one inline more control and expands without a CSS ellipsis', () => {
        vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(80);
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);

        render(<ExpandableDescription text="A long event description" maxLines={3} />);

        expect(screen.getAllByText('…more')).toHaveLength(1);
        expect(screen.getByText('A long event description')).not.toHaveClass('line-clamp-3');

        fireEvent.click(screen.getByRole('button', { name: '…more' }));
        expect(screen.queryByText('…more')).toBeNull();
        expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
    });
});
