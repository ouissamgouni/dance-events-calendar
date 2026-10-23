import { useEffect, useState } from 'react';
import AdminUserMultiPicker from './AdminUserMultiPicker';
import {
    fetchPeopleDiscoveryStats,
    fetchSettings,
    forcePeopleJoined,
    forcePeoplePrompt,
    updateSettings,
    type AdminUserRow,
    type PeopleDiscoveryStats,
    type PeopleJoinedForceResult,
    type PeoplePromptForceResult,
    type SiteSettings,
} from '../api';

type ToggleKey = 'people_prompt_enabled' | 'people_joined_enabled';

type IntKey =
    | 'people_prompt_tier1_max_friends'
    | 'people_prompt_tier1_cooldown_hours'
    | 'people_prompt_tier2_max_friends'
    | 'people_prompt_tier2_cooldown_hours'
    | 'people_prompt_fatigue_dismissals'
    | 'people_prompt_fatigue_pause_days'
    | 'people_prompt_min_suggestions'
    | 'people_trail_top_max_friends'
    | 'home_overlays_per_session'
    | 'suggestion_dismissal_ttl_days'
    | 'people_joined_window_days'
    | 'people_joined_min_mutual'
    | 'people_joined_min_mutual_curators'
    | 'people_joined_max_recipients'
    | 'people_joined_push_start_hour'
    | 'people_joined_push_end_hour';

const TOGGLES: { key: ToggleKey; label: string; help: string }[] = [
    {
        key: 'people_prompt_enabled',
        label: 'Home "Build your tribe" sheet',
        help: 'Opens a people-suggestions sheet on Home, at a cadence based on the user\u2019s friend count. Shown after the review prompt, before install/push banners.',
    },
    {
        key: 'people_joined_enabled',
        label: '"Someone you may know joined"',
        help: 'In-app + push (max 1/day, local daytime) when a new member shares connections with the user. Private and hidden-from-suggestions members never trigger it.',
    },
];

const INT_FIELDS: { key: IntKey; label: string; help: string; fallback: number; max: number }[] = [
    { key: 'people_prompt_tier1_max_friends', label: 'Sheet tier 1: max friends', help: 'Small circles (friends = mutual follows) up to this size', fallback: 2, max: 1000 },
    { key: 'people_prompt_tier1_cooldown_hours', label: 'Sheet tier 1: every (hours)', help: 'Cadence for tier 1', fallback: 48, max: 2160 },
    { key: 'people_prompt_tier2_max_friends', label: 'Sheet tier 2: max friends', help: 'Above this the sheet never shows (trail only)', fallback: 9, max: 1000 },
    { key: 'people_prompt_tier2_cooldown_hours', label: 'Sheet tier 2: every (hours)', help: 'Cadence for tier 2', fallback: 168, max: 2160 },
    { key: 'people_prompt_fatigue_dismissals', label: 'Sheet fatigue: dismissals in a row', help: 'Consecutive sheets without a follow before pausing', fallback: 3, max: 50 },
    { key: 'people_prompt_fatigue_pause_days', label: 'Sheet fatigue: pause (days)', help: 'How long the sheet pauses after the fatigue threshold', fallback: 30, max: 365 },
    { key: 'people_prompt_min_suggestions', label: 'Sheet: min suggestions', help: 'Skip the sheet when fewer people are available', fallback: 3, max: 5 },
    { key: 'people_trail_top_max_friends', label: 'Trail on top: max friends', help: 'For You shows "Build your tribe" right after "You might like" up to this friend count', fallback: 9, max: 1000 },
    { key: 'home_overlays_per_session', label: 'Home sheets per session', help: 'Review + people sheets combined (forced sheets ignore this)', fallback: 1, max: 3 },
    { key: 'suggestion_dismissal_ttl_days', label: '"Not interested" lasts (days)', help: 'Dismissed people reappear after this', fallback: 90, max: 3650 },
    { key: 'people_joined_window_days', label: 'Joined: window (days)', help: 'New members are matched for this long after sign-up', fallback: 14, max: 90 },
    { key: 'people_joined_min_mutual', label: 'Joined: min mutual (regular)', help: 'Shared connections with regular members', fallback: 1, max: 50 },
    { key: 'people_joined_min_mutual_curators', label: 'Joined: min mutual (incl. curators)', help: 'When curators/organizers are among the shared connections', fallback: 2, max: 50 },
    { key: 'people_joined_max_recipients', label: 'Joined: max recipients per member', help: 'Regular-connection matches are notified first', fallback: 50, max: 1000 },
    { key: 'people_joined_push_start_hour', label: 'Joined push: from (local hour)', help: 'Earliest local hour to push', fallback: 10, max: 23 },
    { key: 'people_joined_push_end_hour', label: 'Joined push: until (local hour)', help: 'Push stops at this local hour', fallback: 21, max: 24 },
];

const JOINED_REASONS: Record<string, string> = {
    inactive: 'inactive/curator',
    already_follows: 'already connected',
    dismissed: 'dismissed',
    below_threshold: 'below threshold',
    already_notified: 'already notified',
};

/** Admin settings, last-30-days stats and send-now tools for people discovery. */
export default function AdminPeopleDiscoverySettings({ onMessage }: { onMessage: (msg: string) => void }) {
    const [toggles, setToggles] = useState<Record<ToggleKey, boolean>>({ people_prompt_enabled: true, people_joined_enabled: true });
    const [values, setValues] = useState<Record<IntKey, number>>(
        () => Object.fromEntries(INT_FIELDS.map((f) => [f.key, f.fallback])) as Record<IntKey, number>,
    );
    const [stats, setStats] = useState<PeopleDiscoveryStats | null>(null);
    const [promptUsers, setPromptUsers] = useState<AdminUserRow[]>([]);
    const [promptAll, setPromptAll] = useState(false);
    const [promptPreview, setPromptPreview] = useState<PeoplePromptForceResult | null>(null);
    const [joiners, setJoiners] = useState<AdminUserRow[]>([]);
    const [joinersRecent, setJoinersRecent] = useState(false);
    const [joinedPush, setJoinedPush] = useState(true);
    const [joinedPreview, setJoinedPreview] = useState<PeopleJoinedForceResult | null>(null);
    const [busy, setBusy] = useState(false);

    const loadStats = () => fetchPeopleDiscoveryStats(30).then(setStats).catch(() => setStats(null));

    useEffect(() => {
        fetchSettings()
            .then((s: SiteSettings) => {
                setToggles({
                    people_prompt_enabled: s.people_prompt_enabled ?? true,
                    people_joined_enabled: s.people_joined_enabled ?? true,
                });
                setValues((prev) => {
                    const next = { ...prev };
                    for (const f of INT_FIELDS) next[f.key] = s[f.key] ?? f.fallback;
                    return next;
                });
            })
            .catch(() => { });
        void loadStats();
    }, []);

    const toggle = async ({ key, label }: (typeof TOGGLES)[number]) => {
        const next = !toggles[key];
        setToggles((prev) => ({ ...prev, [key]: next }));
        try {
            await updateSettings({ [key]: next });
            onMessage(`${label} ${next ? 'enabled' : 'disabled'}.`);
        } catch {
            setToggles((prev) => ({ ...prev, [key]: !next }));
            onMessage(`Failed to update ${label}.`);
        }
    };

    const save = async (field: (typeof INT_FIELDS)[number], value: number) => {
        if (!Number.isFinite(value) || value < 1 || value > field.max) return;
        try {
            await updateSettings({ [field.key]: value });
            onMessage(`${field.label} set to ${value}.`);
        } catch {
            onMessage(`Failed to update ${field.label.toLowerCase()}.`);
        }
    };

    const hasPromptTarget = promptAll || promptUsers.length > 0;
    const runPrompt = async (dryRun: boolean) => {
        if (!hasPromptTarget) return;
        setBusy(true);
        try {
            const target = promptAll ? { allUsers: true as const } : { userIds: promptUsers.map((u) => u.user_id) };
            const res = await forcePeoplePrompt(target, dryRun);
            setPromptPreview(res);
            if (!dryRun) {
                onMessage(res.forced > 0 ? `People sheet forced for ${res.forced} user(s)' next session.` : 'Nobody forced (see warnings).');
                void loadStats();
            }
        } catch {
            onMessage('Failed to force the people sheet.');
        } finally {
            setBusy(false);
        }
    };

    const hasJoinedTarget = joinersRecent || joiners.length > 0;
    const runJoined = async (dryRun: boolean) => {
        if (!hasJoinedTarget) return;
        setBusy(true);
        try {
            const target = joinersRecent
                ? { allRecentJoiners: true as const }
                : { joinerUserIds: joiners.map((u) => u.user_id) };
            const res = await forcePeopleJoined(target, joinedPush ? ['app', 'push'] : ['app'], dryRun);
            setJoinedPreview(res);
            if (!dryRun) {
                onMessage(`Joined notification: ${res.created} created, ${res.pushed} pushed.`);
                void loadStats();
            }
        } catch {
            onMessage('Failed to send joined notifications.');
        } finally {
            setBusy(false);
        }
    };

    const conversion = stats && stats.shown > 0 ? Math.round((stats.followed / stats.shown) * 100) : null;
    const promptForceable = promptPreview
        ? !promptPreview.warning && (promptPreview.all_users ? promptPreview.targeted > 0 : promptPreview.users.some((u) => !u.warning))
        : false;
    const eligibleJoined = joinedPreview?.joiners.reduce(
        (n, j) => n + j.candidates.filter((c) => c.reason === null).length,
        0,
    ) ?? 0;

    return (
        <div className="border border-card-line p-3 space-y-3" data-testid="admin-people-discovery">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink">People discovery</span>
            {TOGGLES.map((t) => (
                <div key={t.key} className="flex items-center justify-between gap-3">
                    <div>
                        <span className="text-[11px] font-medium text-ink">{t.label}</span>
                        <p className="text-[10px] text-muted">{t.help}</p>
                    </div>
                    <button
                        onClick={() => toggle(t)}
                        aria-label={`Toggle ${t.label}`}
                        aria-pressed={toggles[t.key]}
                        // eslint-disable-next-line no-restricted-syntax -- toggle switch is circular by design
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${toggles[t.key] ? 'bg-success' : 'bg-gray-300'}`}
                    >
                        {/* eslint-disable-next-line no-restricted-syntax -- toggle knob is circular by design */}
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-surface transition ${toggles[t.key] ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </button>
                </div>
            ))}
            {INT_FIELDS.map((field) => (
                <div key={field.key} className="flex items-center justify-between border-t border-card-line pt-2.5">
                    <div>
                        <span className="text-[11px] font-medium text-ink">{field.label}</span>
                        <p className="text-[10px] text-muted">{field.help} (1–{field.max})</p>
                    </div>
                    <input
                        type="number"
                        min={1}
                        max={field.max}
                        value={values[field.key]}
                        onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: Number(e.target.value) }))}
                        onBlur={(e) => save(field, Number(e.target.value))}
                        onKeyDown={(e) => e.key === 'Enter' && save(field, values[field.key])}
                        className="w-16 text-right text-[11px] border border-line px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-success"
                        aria-label={field.label}
                    />
                </div>
            ))}

            <div className="border-t border-card-line pt-2.5 space-y-1.5">
                <span className="text-[11px] font-medium text-ink">Last 30 days</span>
                {stats ? (
                    <>
                        <p className="text-[11px] text-ink-soft">
                            Sheet: shown {stats.shown} · dismissed {stats.dismissed} · followed {stats.followed}
                            {conversion != null && ` (${conversion}%)`} · {stats.follows} follows · forced {stats.forced_shown}
                        </p>
                        <p className="text-[11px] text-ink-soft">
                            Joined: notified {stats.joined_created} · pushed {stats.joined_pushed} · followed back {stats.joined_followed}
                        </p>
                    </>
                ) : (
                    <p className="text-[10px] text-muted">No stats yet.</p>
                )}
            </div>

            <div className="border-t border-card-line pt-2.5 space-y-1.5">
                <span className="text-[11px] font-medium text-ink">Force people sheet</span>
                <p className="text-[10px] text-muted">Shows on the user&rsquo;s next session regardless of tier, cooldown or fatigue (expires after 7 days).</p>
                <div className="flex flex-wrap items-center gap-2">
                    {!promptAll && (
                        <AdminUserMultiPicker
                            selected={promptUsers}
                            onChange={(rows) => { setPromptUsers(rows); setPromptPreview(null); }}
                            buttonLabel="Pick users"
                        />
                    )}
                    <label className="flex items-center gap-1 text-[11px]">
                        <input
                            type="checkbox"
                            checked={promptAll}
                            onChange={(e) => { setPromptAll(e.target.checked); setPromptPreview(null); }}
                        />
                        All users
                    </label>
                    <div className="ml-auto flex gap-1 text-[11px]">
                        <button type="button" disabled={busy || !hasPromptTarget} onClick={() => void runPrompt(true)} className="border border-line bg-surface px-2 py-0.5 hover:bg-canvas disabled:opacity-50">Preview</button>
                        <button type="button" disabled={busy || !promptForceable} onClick={() => void runPrompt(false)} className="bg-action px-2 py-0.5 text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">Confirm</button>
                    </div>
                </div>
                {promptPreview && (
                    <div className="text-[10px] text-ink-soft bg-canvas border border-line p-2 space-y-1" role="status">
                        <p className="font-medium text-ink">
                            {promptPreview.dry_run
                                ? `${promptPreview.targeted} user(s) targeted`
                                : `${promptPreview.forced} of ${promptPreview.targeted} forced`}
                            {promptPreview.all_users && ' (all users; those without suggestions won\u2019t see a sheet)'}
                        </p>
                        {promptPreview.warning === 'disabled' && <p className="text-danger">The sheet is disabled.</p>}
                        {promptPreview.users.map((u) => (
                            <div key={u.user_id}>
                                <span className="text-ink">{u.display_name || `@${u.handle}`}</span>
                                {` \u00b7 ${u.friend_count} friends \u00b7 ${u.total} suggestions`}
                                {u.forced_until && ` \u00b7 forced until ${new Date(u.forced_until).toLocaleString()}`}
                                {u.warning === 'no_suggestions' && <span className="text-danger"> · no suggestions</span>}
                                {u.items.length > 0 && <span className="block text-muted">Would show: {u.items.map((i) => `@${i.handle}`).join(', ')}</span>}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="border-t border-card-line pt-2.5 space-y-1.5">
                <span className="text-[11px] font-medium text-ink">Send &ldquo;joined&rdquo; notification</span>
                <p className="text-[10px] text-muted">Pick the new members. Ignores the join window and recipient cap; never their privacy settings or recipients&rsquo; push opt-out.</p>
                <div className="flex flex-wrap items-center gap-2">
                    {!joinersRecent && (
                        <AdminUserMultiPicker
                            selected={joiners}
                            onChange={(rows) => { setJoiners(rows); setJoinedPreview(null); }}
                            buttonLabel="Pick members"
                        />
                    )}
                    <label className="flex items-center gap-1 text-[11px]">
                        <input
                            type="checkbox"
                            checked={joinersRecent}
                            onChange={(e) => { setJoinersRecent(e.target.checked); setJoinedPreview(null); }}
                        />
                        All recent joiners
                    </label>
                    <label className="flex items-center gap-1 text-[11px]">
                        <input type="checkbox" checked={joinedPush} onChange={(e) => setJoinedPush(e.target.checked)} />
                        Push
                    </label>
                    <div className="ml-auto flex gap-1 text-[11px]">
                        <button type="button" disabled={busy || !hasJoinedTarget} onClick={() => void runJoined(true)} className="border border-line bg-surface px-2 py-0.5 hover:bg-canvas disabled:opacity-50">Preview</button>
                        <button type="button" disabled={busy || eligibleJoined === 0} onClick={() => void runJoined(false)} className="bg-action px-2 py-0.5 text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">Confirm</button>
                    </div>
                </div>
                {joinedPreview && (
                    <div className="text-[10px] text-ink-soft bg-canvas border border-line p-2 space-y-1.5" role="status">
                        {joinedPreview.joiners.length === 0 && <p>No members joined within the window.</p>}
                        {joinedPreview.joiners.map((j) => (
                            <div key={j.joiner_user_id}>
                                <p className="font-medium text-ink">{j.joiner_display_name || `@${j.joiner_handle}`}</p>
                                {j.joiner_warning && <p className="text-danger">Member: {j.joiner_warning.replace(/_/g, ' ')}</p>}
                                {j.candidates.length === 0 ? (
                                    <p>No one shares a connection with this member.</p>
                                ) : (
                                    <ul>
                                        {j.candidates.map((c) => (
                                            <li key={c.user_id} className="flex justify-between gap-2">
                                                <span className="truncate">{c.display_name || `@${c.handle}`}</span>
                                                <span className="tabular-nums">
                                                    {c.regular_mutual} regular · {c.curator_mutual} curator · {c.reason ? JOINED_REASONS[c.reason] : c.push_enabled ? 'will notify' : 'in-app only'}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
