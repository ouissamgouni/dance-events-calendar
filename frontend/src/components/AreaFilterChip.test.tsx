import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AreaFilterChip from './AreaFilterChip';

describe('AreaFilterChip', () => {
    it('shows the area name without a profile-name prefix', () => {
        render(<AreaFilterChip state={{ kind: 'user', label: 'Greater Barcelona' }} />);

        expect(screen.getByTestId('area-filter-chip')).toHaveTextContent('Greater Barcelona');
        expect(screen.getByTestId('area-filter-chip')).not.toHaveTextContent('Your profile area');
    });
});
