import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMyPlanShare, downloadMyPlanIcs, fetchMyPlanShare, revokeMyPlanShare } from '../api';
import { saveDownload } from '../utils/download';
import MyPlanUtilityMenu from './MyPlanUtilityMenu';

vi.mock('../api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api')>();
    return {
        ...actual,
        createMyPlanShare: vi.fn(),
        downloadMyPlanIcs: vi.fn(),
        fetchMyPlanShare: vi.fn(),
        revokeMyPlanShare: vi.fn(),
    };
});
vi.mock('../utils/download', () => ({ saveDownload: vi.fn() }));

describe('MyPlanUtilityMenu', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(fetchMyPlanShare).mockResolvedValue(null);
        vi.mocked(createMyPlanShare).mockResolvedValue({ token: 'plan-token' });
        vi.mocked(revokeMyPlanShare).mockResolvedValue();
        vi.mocked(downloadMyPlanIcs).mockResolvedValue({ blob: new Blob(['calendar']), filename: 'my-plan.ics' });
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: vi.fn().mockResolvedValue(undefined) },
        });
        Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    });

    it('shares, downloads, and revokes a live plan link', async () => {
        render(<MyPlanUtilityMenu eventId="event-1" />);
        fireEvent.click(screen.getByRole('button', { name: 'Share and export My Plan' }));
        await waitFor(() => expect(fetchMyPlanShare).toHaveBeenCalledWith('event-1'));

        fireEvent.click(screen.getByRole('button', { name: /^Share My Plan/ }));
        await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('/shared/plan/plan-token')));
        expect(screen.getByRole('button', { name: 'Stop sharing' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /^Download calendar \(.ics\)/ }));
        await waitFor(() => expect(saveDownload).toHaveBeenCalledWith(expect.objectContaining({ filename: 'my-plan.ics' })));

        fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));
        await waitFor(() => expect(revokeMyPlanShare).toHaveBeenCalledWith('event-1'));
        expect(screen.queryByRole('button', { name: 'Stop sharing' })).not.toBeInTheDocument();
    });
});
