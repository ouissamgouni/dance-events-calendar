/**
 * Small read-only badges showing a user's per-feature notification channel
 * status (email/push toggles + web push subscription). Shared by the admin
 * Users table (`AdminUsersTab`) and the force-send/send-now target user
 * picker's table view (`AdminUserMultiPicker`) so both surfaces render the
 * same columns consistently.
 */

const DOT_ON =
    'inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-100 text-[9px] font-semibold text-emerald-700';
const DOT_OFF =
    'inline-flex h-4 w-4 items-center justify-center rounded-full bg-gray-100 text-[9px] font-semibold text-gray-400';

function Dot({ on, letter, title }: { on: boolean; letter: string; title: string }) {
    return (
        <span className={on ? DOT_ON : DOT_OFF} title={title} aria-label={title}>
            {letter}
        </span>
    );
}

/** Email + push status pair for one notification feature (e.g. interest-match). */
export function FeatureStatusCell({ label, email, push }: { label: string; email: boolean; push: boolean }) {
    return (
        <div className="flex items-center gap-1">
            <Dot on={email} letter="E" title={`${label} · email ${email ? 'on' : 'off'}`} />
            <Dot on={push} letter="P" title={`${label} · push ${push ? 'on' : 'off'}`} />
        </div>
    );
}

/** Whether the user has at least one registered Web Push browser endpoint. */
export function PushSubscriptionCell({ on }: { on: boolean }) {
    return <Dot on={on} letter="P" title={`Web push subscription ${on ? 'registered' : 'none'}`} />;
}
