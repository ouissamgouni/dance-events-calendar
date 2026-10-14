export type SignInIntent =
    | 'generic'
    | 'save'
    | 'going'
    | 'people'
    | 'review'
    | 'message'
    | 'follow'
    | 'calendar'
    | 'my_plans'
    | 'explore'
    | 'claim';

export const SIGN_IN_INTENT_COPY: Record<SignInIntent, { headline: string; subtitle: string }> = {
    generic: {
        headline: 'Your dance life, connected.',
        subtitle: 'Sign in or create a free account to keep your plans, join conversations and stay updated.',
    },
    save: {
        headline: 'Keep it in your plans.',
        subtitle: 'Sign in to save this event and find it later.',
    },
    going: {
        headline: 'Count yourself in.',
        subtitle: 'Sign in to save this event and let your friends know you’re going.',
    },
    people: {
        headline: 'See who’s dancing.',
        subtitle: 'Sign in to see which friends and dancers are going.',
    },
    review: {
        headline: 'Share your experience.',
        subtitle: 'Sign in to help other dancers decide where to go next.',
    },
    message: {
        headline: 'Join the conversation.',
        subtitle: 'Sign in to ask questions, reply and make plans together.',
    },
    follow: {
        headline: 'Follow dancers you know.',
        subtitle: 'Sign in to see where they’re dancing next.',
    },
    calendar: {
        headline: 'Take your plans anywhere.',
        subtitle: 'Sign in to sync your events with Apple or Google Calendar.',
    },
    my_plans: {
        headline: 'Your plans, together.',
        subtitle: 'Sign in to organise your saved and upcoming events.',
    },
    explore: {
        headline: 'See every upcoming event.',
        subtitle: 'Sign in to plan months ahead, not just the next few weeks.',
    },
    claim: {
        headline: 'Run this event?',
        subtitle: 'Sign in to claim it and keep its details up to date.',
    },
};

export const FULL_PAGE_COPY = {
    headline: 'Your dance plans, together.',
    subtitle: 'Discover and save events, connect with dancers and stay updated.',
};

export const SIGN_IN_BENEFITS = ['Save events', 'Plan together', 'Stay updated'] as const;

const INTENTS = new Set<string>(Object.keys(SIGN_IN_INTENT_COPY));

export function resolveSignInIntent(intentParam: string | null, next: string | null): SignInIntent {
    if (intentParam && INTENTS.has(intentParam)) return intentParam as SignInIntent;
    if (!next) return 'generic';
    if (next.includes('#community')) return 'review';
    if (next.includes('#messages') || next.includes('tab=discussion')) return 'message';
    if (next.includes('#people') || next.startsWith('/tribe/calendars')) return 'people';
    if (next.startsWith('/my-events')) return 'my_plans';
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
