import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AvatarEditor from './AvatarEditor';
import * as api from '../api';

vi.mock('../api', () => ({
    uploadUserAvatar: vi.fn(),
    deleteUserAvatar: vi.fn(),
}));

describe('AvatarEditor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('shows a provider picture without a remove action', () => {
        render(
            <AvatarEditor
                avatarUrl="https://provider.test/avatar.jpg"
                hasCustomAvatar={false}
                name="Nora"
            />,
        );

        expect(screen.getByRole('img', { name: 'Your profile' })).toHaveAttribute(
            'src',
            'https://provider.test/avatar.jpg',
        );
        expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    });

    it('uploads a selected picture and reports the managed avatar', async () => {
        const update = {
            avatar_url: 'https://cdn.test/users/1/avatar/new/avatar.webp',
            has_custom_avatar: true,
        };
        vi.mocked(api.uploadUserAvatar).mockResolvedValue(update);
        const onChange = vi.fn();
        render(
            <AvatarEditor
                avatarUrl={null}
                hasCustomAvatar={false}
                name="Nora"
                onChange={onChange}
            />,
        );

        const file = new File(['picture'], 'avatar.png', { type: 'image/png' });
        await userEvent.upload(screen.getByLabelText('Upload profile picture'), file);

        await waitFor(() => expect(api.uploadUserAvatar).toHaveBeenCalledWith(file));
        expect(onChange).toHaveBeenCalledWith(update);
        expect(screen.getByRole('img', { name: 'Your profile' })).toHaveAttribute(
            'src',
            update.avatar_url,
        );
        expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    });

    it('removes a managed picture and restores the provider fallback', async () => {
        const update = {
            avatar_url: 'https://provider.test/avatar.jpg',
            has_custom_avatar: false,
        };
        vi.mocked(api.deleteUserAvatar).mockResolvedValue(update);
        render(
            <AvatarEditor
                avatarUrl="https://cdn.test/avatar.webp"
                hasCustomAvatar
                name="Nora"
            />,
        );

        await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

        await waitFor(() => expect(api.deleteUserAvatar).toHaveBeenCalled());
        expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
        expect(screen.getByRole('img', { name: 'Your profile' })).toHaveAttribute(
            'src',
            update.avatar_url,
        );
    });

    it('shows upload failures inline', async () => {
        vi.mocked(api.uploadUserAvatar).mockRejectedValue(new Error('Unsupported image type'));
        render(
            <AvatarEditor
                avatarUrl={null}
                hasCustomAvatar={false}
                name="Nora"
            />,
        );

        await userEvent.upload(
            screen.getByLabelText('Upload profile picture'),
            new File(['bad'], 'broken.png', { type: 'image/png' }),
        );

        expect(await screen.findByRole('alert')).toHaveTextContent('Unsupported image type');
    });
});
