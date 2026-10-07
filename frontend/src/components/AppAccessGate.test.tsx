import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import AppAccessGate from './AppAccessGate';
import { AuthProvider } from '../context/AuthContext';
import { defaultFlags, FeatureFlagsContext } from '../context/FeatureFlagsContext';
import { makeUser } from '../test/handlers';
import { server } from '../test/server';

function LocationProbe() {
    const location = useLocation();
    return (
        <div data-testid="location">
            {location.pathname + location.search + location.hash}
        </div>
    );
}

function renderGate(
    initialPath: string,
    { enabled = false, ready = true }: { enabled?: boolean; ready?: boolean } = {},
) {
    return render(
        <MemoryRouter initialEntries={[initialPath]}>
            <AuthProvider>
                <FeatureFlagsContext.Provider
                    value={{
                        flags: { ...defaultFlags, appAuthGateEnabled: enabled },
                        updateFlag: vi.fn(),
                        ready,
                    }}
                >
                    <AppAccessGate>
                        <LocationProbe />
                    </AppAccessGate>
                </FeatureFlagsContext.Provider>
            </AuthProvider>
        </MemoryRouter>,
    );
}

describe('AppAccessGate', () => {
    it('keeps partial access on non-root app routes when disabled', async () => {
        renderGate('/search?q=salsa');

        await waitFor(() =>
            expect(screen.getByTestId('location')).toHaveTextContent('/search?q=salsa'),
        );
    });

    it('redirects an anonymous root visit to Browse when disabled', async () => {
        renderGate('/?city=Berlin#list');

        await waitFor(() =>
            expect(screen.getByTestId('location')).toHaveTextContent('/browse?city=Berlin#list'),
        );
    });

    it('redirects gated routes to login with the full return URL', async () => {
        renderGate('/search?q=salsa#map', { enabled: true });

        await waitFor(() =>
            expect(screen.getByTestId('location')).toHaveTextContent(
                '/login?next=%2Fsearch%3Fq%3Dsalsa%23map',
            ),
        );
    });

    it('sends the root route to login instead of Browse when enabled', async () => {
        renderGate('/', { enabled: true });

        await waitFor(() =>
            expect(screen.getByTestId('location')).toHaveTextContent('/login?next=%2F'),
        );
    });

    it('allows signed-in users through when enabled', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
        );
        renderGate('/browse', { enabled: true });

        await waitFor(() =>
            expect(screen.getByTestId('location')).toHaveTextContent('/browse'),
        );
    });

    it.each([
        '/login',
        '/privacy',
        '/terms',
        '/legal',
        '/invite',
        '/install',
        '/r/invite-code',
        '/event/event-1',
        '/series/series-1',
        '/u/dancer',
        '/shared/calendar-token',
    ])('keeps public route %s readable when enabled', (path) => {
        renderGate(path, { enabled: true });

        expect(screen.getByTestId('location')).toHaveTextContent(path);
    });

    it('does not reveal a gated route before settings resolve', async () => {
        renderGate('/browse', { enabled: true, ready: false });

        expect(screen.getByText('Loading…')).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByTestId('location')).not.toBeInTheDocument());
    });
});
