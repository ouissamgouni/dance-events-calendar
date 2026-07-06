import { useAuth } from '../context/AuthContext';
import { updateNotificationPreferences } from '../api';
import { usePush } from '../hooks/usePush';
import ToggleRow from './ToggleRow';

/**
 * Device-scoped push notification toggle.
 *
 * Web Push is a per-browser capability, not an account feature, so this
 * renders for anonymous AND signed-in visitors alike (unlike the rest of
 * {@link NotificationSettings}, which is email/account-scoped and requires
 * sign-in). Signed-in users additionally get the server-side
 * ``push_enabled`` preference flipped so other surfaces (e.g. digest email
 * fallbacks) know this device already gets push.
 */
export default function PushNotificationSettings() {
    const { user, refreshUser } = useAuth();
    const push = usePush(user?.user_id);

    const checked = push.status === 'on';
    const visible = push.status !== 'unsupported' && push.status !== 'disabled';
    const denied = push.status === 'denied';

    if (!visible) return null;

    const toggle = async (next: boolean) => {
        if (next) {
            await push.enable();
        } else {
            await push.disable();
        }
        if (user) {
            try {
                await updateNotificationPreferences({ push_enabled: next });
                await refreshUser();
            } catch {
                // Non-fatal: the device subscription itself already succeeded/failed
                // above; the server flag is best-effort bookkeeping.
            }
        }
    };

    return (
        <section className="border border-slate-200 bg-white p-4 mb-3">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Push notifications</h2>
            <ToggleRow
                label="Push notifications"
                description={
                    denied
                        ? 'Blocked in your browser settings — re-enable notifications for this site to turn on.'
                        : 'Get reminders and activity alerts on this device, even when Movida is closed.'
                }
                checked={checked}
                busy={push.busy}
                disabled={denied}
                onChange={toggle}
            />
            {push.error && <p className="mt-2 text-xs text-red-600">{push.error}</p>}
        </section>
    );
}
