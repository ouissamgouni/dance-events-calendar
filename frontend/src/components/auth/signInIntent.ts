export type SignInIntent =
    | 'generic'
    | 'save'
    | 'going'
    | 'people'
    | 'review'
    | 'message'
    | 'follow'
    | 'calendar';

export const SIGN_IN_INTENT_COPY: Record<SignInIntent, { headline: string; subtitle: string }> = {
    generic: {
        headline: 'Get more out of Movida',
        subtitle: 'Free account, no password. Works whether you’re new or coming back.',
    },
    save: {
        headline: 'Keep this event saved',
        subtitle: 'Right now it’s only saved on this device. With an account it’s on every device, with reminders.',
    },
    going: {
        headline: 'Tell your friends you’re going',
        subtitle: 'Share your plans and get updates before the event.',
    },
    people: {
        headline: 'See who’s going',
        subtitle: 'Find friends and dancers you know at this event.',
    },
    review: {
        headline: 'Share how it was',
        subtitle: 'Rate this event and see what other dancers thought.',
    },
    message: {
        headline: 'Join the conversation',
        subtitle: 'Ask the organiser and other dancers a question.',
    },
    follow: {
        headline: 'Follow dancers you know',
        subtitle: 'See where they’re dancing next.',
    },
    calendar: {
        headline: 'Sync your calendar',
        subtitle: 'Subscribe in Apple or Google Calendar and share your plans.',
    },
};

export const SIGN_IN_BENEFITS = [
    'Keep your saved events and plans on every device',
    'See which friends are going and follow dancers you know',
    'Get reminders and updates for events you’re going to',
    'Rate events, join discussions and build your dance passport',
];

const INTENTS = new Set<string>(Object.keys(SIGN_IN_INTENT_COPY));

export function resolveSignInIntent(intentParam: string | null, next: string | null): SignInIntent {
    if (intentParam && INTENTS.has(intentParam)) return intentParam as SignInIntent;
    if (!next) return 'generic';
    if (next.includes('#community')) return 'review';
    if (next.includes('#messages') || next.includes('tab=discussion')) return 'message';
    if (next.includes('#people')) return 'people';
    if (next.startsWith('/tribe/calendars') || next.startsWith('/my-events')) return 'calendar';
    return 'generic';
}

export function signInPath(next: string, intent: SignInIntent = 'generic'): string {
    const base = `/login?next=${encodeURIComponent(next)}`;
    return intent === 'generic' ? base : `${base}&intent=${intent}`;
}

const MAIL_APPS: { domains: string[]; label: string; href: string }[] = [
    { domains: ['gmail.com', 'googlemail.com'], label: 'Open Gmail', href: 'https://mail.google.com/mail/u/0/#inbox' },
    { domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'], label: 'Open Outlook', href: 'https://outlook.live.com/mail/0/inbox' },
    { domains: ['icloud.com', 'me.com', 'mac.com'], label: 'Open iCloud Mail', href: 'https://www.icloud.com/mail' },
    { domains: ['yahoo.com'], label: 'Open Yahoo Mail', href: 'https://mail.yahoo.com' },
    { domains: ['proton.me', 'protonmail.com'], label: 'Open Proton Mail', href: 'https://mail.proton.me' },
];

export function mailAppFor(email: string): { label: string; href: string } | null {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return null;
    const app = MAIL_APPS.find((a) => a.domains.includes(domain));
    return app ? { label: app.label, href: app.href } : null;
}
