import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMyPlanCounts } from '../api';
import { MyPlanCountProvider, useMyPlanCount, useSetMyPlanCount } from './MyPlanCountContext';

vi.mock('../api', () => ({
    fetchMyPlanCounts: vi.fn(),
}));

const auth = vi.hoisted(() => ({ user: { user_id: 'viewer-1' } }));
vi.mock('./AuthContext', () => ({
    useAuth: () => auth,
}));

function Count({ eventId }: { eventId: string }) {
    const count = useMyPlanCount(eventId);
    return <span>{eventId}:{count ?? 'unknown'}</span>;
}

describe('MyPlanCountProvider', () => {
    beforeEach(() => {
        vi.mocked(fetchMyPlanCounts).mockResolvedValue([
            { event_id: 'event-1', plan_count: 3 },
            { event_id: 'event-2', plan_count: 0 },
        ]);
    });

    it('coalesces registrations and preserves exact numeric counts', async () => {
        render(
            <MyPlanCountProvider>
                <Count eventId="event-1" />
                <Count eventId="event-2" />
            </MyPlanCountProvider>,
        );

        expect(await screen.findByText('event-1:3')).toBeInTheDocument();
        expect(screen.getByText('event-2:0')).toBeInTheDocument();
        expect(fetchMyPlanCounts).toHaveBeenCalledOnce();
        expect(fetchMyPlanCounts).toHaveBeenCalledWith(['event-1', 'event-2']);
    });

    it('updates a cached count when the plan changes', async () => {
        function Clear() {
            const setCount = useSetMyPlanCount();
            return <button type="button" onClick={() => setCount('event-1', 0)}>clear</button>;
        }
        render(
            <MyPlanCountProvider>
                <Count eventId="event-1" />
                <Clear />
            </MyPlanCountProvider>,
        );

        expect(await screen.findByText('event-1:3')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'clear' }));
        expect(screen.getByText('event-1:0')).toBeInTheDocument();
    });
});
