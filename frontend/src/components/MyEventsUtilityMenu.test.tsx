import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../test/render';
import MyEventsUtilityMenu from './MyEventsUtilityMenu';

describe('MyEventsUtilityMenu', () => {
    it('opens the approved Share and export sheet without RSS', async () => {
        const { user } = renderWithProviders(<MyEventsUtilityMenu />);

        await user.click(screen.getByRole('button', { name: 'Share and export My Events' }));

        expect(screen.getByRole('dialog', { name: 'Share & export' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Share My Events/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Subscribe in another calendar/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Export calendar \(.ics\)/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Export spreadsheet \(.xlsx\)/ })).toBeInTheDocument();
        expect(screen.queryByText(/RSS/i)).not.toBeInTheDocument();
    });
});
