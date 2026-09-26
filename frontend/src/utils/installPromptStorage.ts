const PROGRAM_INSTALL_DISMISSED_PREFIX = 'movida:program-install-dismissed:';
const PROGRAM_PUSH_OPT_IN_PREFIX = 'movida:program-push-optin-pending:';

export function programInstallDismissedKey(userId: string, eventId: string): string {
    return `${PROGRAM_INSTALL_DISMISSED_PREFIX}${userId}:${eventId}`;
}

export function programPushOptInKey(userId: string): string {
    return `${PROGRAM_PUSH_OPT_IN_PREFIX}${userId}`;
}
