import { describe, expect, it } from 'vitest';
import { programInstallDismissedKey, programPushOptInKey } from './installPromptStorage';

describe('install prompt storage keys', () => {
    it('scopes contextual dismissal to a user and event', () => {
        expect(programInstallDismissedKey('user-1', 'event-1'))
            .toBe('movida:program-install-dismissed:user-1:event-1');
    });

    it('preserves the existing per-user pending push key', () => {
        expect(programPushOptInKey('user-1'))
            .toBe('movida:program-push-optin-pending:user-1');
    });
});
