import { useEffect, useState } from 'react';
import {
    listCalendarCurationRules,
    createCalendarCurationRule,
    updateCalendarCurationRule,
    deleteCalendarCurationRule,
    type CalendarCurationRule,
    type AdminBulkEngagementAudience,
    type AdminBulkEngagementKind,
} from '../api';

interface Props {
    calendarId: string;
}

const KIND_LABEL: Record<AdminBulkEngagementKind, string> = {
    save: 'Saved',
    going: 'Going',
};

/**
 * Admin: per-calendar curation rules.
 *
 * Lists, creates, edits and deletes rules that auto-add freshly-synced
 * events from one calendar onto an admin-managed target user's
 * Saved/Going list. The backend enforces that the target is flagged
 * ``is_admin_managed`` (409 when not).
 */
export default function CalendarCurationRulesPanel({ calendarId }: Props) {
    const [rules, setRules] = useState<CalendarCurationRule[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [newHandle, setNewHandle] = useState('');
    const [newKind, setNewKind] = useState<AdminBulkEngagementKind>('save');
    const [newAudience, setNewAudience] = useState<'' | AdminBulkEngagementAudience>('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        listCalendarCurationRules(calendarId)
            .then((rows) => {
                if (!cancelled) setRules(rows);
            })
            .catch((e: Error) => {
                if (!cancelled) setError(e.message || 'Failed to load rules');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [calendarId]);

    const handleAdd = async () => {
        const handle = newHandle.trim().replace(/^@/, '');
        if (!handle) return;
        setSaving(true);
        setError(null);
        try {
            const rule = await createCalendarCurationRule(calendarId, {
                target_handle: handle,
                kind: newKind,
                audience: newAudience === '' ? null : newAudience,
                enabled: true,
            });
            // Upsert by id (server may return an existing rule).
            setRules((prev) => {
                const idx = prev.findIndex((r) => r.id === rule.id);
                if (idx >= 0) {
                    const copy = prev.slice();
                    copy[idx] = rule;
                    return copy;
                }
                return [...prev, rule];
            });
            setNewHandle('');
            setNewAudience('');
        } catch (e) {
            setError((e as Error).message || 'Failed to create rule');
        } finally {
            setSaving(false);
        }
    };

    const handleToggle = async (rule: CalendarCurationRule) => {
        try {
            const updated = await updateCalendarCurationRule(calendarId, rule.id, {
                enabled: !rule.enabled,
            });
            setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        } catch (e) {
            setError((e as Error).message || 'Failed to update rule');
        }
    };

    const handleAudienceChange = async (
        rule: CalendarCurationRule,
        next: '' | AdminBulkEngagementAudience,
    ) => {
        try {
            const updated = await updateCalendarCurationRule(calendarId, rule.id, {
                audience: next === '' ? null : next,
            });
            setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        } catch (e) {
            setError((e as Error).message || 'Failed to update rule');
        }
    };

    const handleDelete = async (rule: CalendarCurationRule) => {
        if (!window.confirm(`Delete curation rule for @${rule.target_handle ?? rule.target_user_id}?`)) return;
        try {
            await deleteCalendarCurationRule(calendarId, rule.id);
            setRules((prev) => prev.filter((r) => r.id !== rule.id));
        } catch (e) {
            setError((e as Error).message || 'Failed to delete rule');
        }
    };

    return (
        <div className="mt-2 pl-6 space-y-2">
            <p className="text-[10px] text-gray-400">
                Curation rules — synced events from this calendar are auto-added to each target's
                Saved/Going list. Targets must be flagged "managed".
            </p>
            {error && (
                <p className="text-[10px] text-red-600">{error}</p>
            )}
            {loading ? (
                <p className="text-[10px] text-gray-400">Loading…</p>
            ) : rules.length === 0 ? (
                <p className="text-[10px] text-gray-400">No rules yet.</p>
            ) : (
                <ul className="space-y-1">
                    {rules.map((r) => (
                        <li key={r.id} className="flex items-center gap-2 text-[10px]">
                            <span className="font-medium text-gray-700 truncate min-w-0">
                                @{r.target_handle ?? r.target_user_id.slice(0, 8)}
                            </span>
                            <span className="px-1.5 py-0.5 bg-indigo-50 text-indigo-700 border border-indigo-200">
                                {KIND_LABEL[r.kind]}
                            </span>
                            <select
                                value={r.audience ?? ''}
                                onChange={(e) =>
                                    handleAudienceChange(
                                        r,
                                        e.target.value as '' | AdminBulkEngagementAudience,
                                    )
                                }
                                className="text-[10px] border border-gray-200 px-1 py-0.5 bg-white"
                                title="Audience override; empty = target's profile default"
                            >
                                <option value="">default</option>
                                <option value="public">public</option>
                                <option value="friends">friends</option>
                                <option value="private">private</option>
                            </select>
                            <button
                                onClick={() => handleToggle(r)}
                                className={`text-[10px] font-medium px-2 py-0.5 transition ${r.enabled
                                    ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                    : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                                    }`}
                            >
                                {r.enabled ? 'On' : 'Off'}
                            </button>
                            <button
                                onClick={() => handleDelete(r)}
                                className="text-[10px] text-red-600 hover:text-red-800"
                                title="Delete rule"
                            >
                                ×
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-gray-100">
                <input
                    type="text"
                    placeholder="@handle"
                    value={newHandle}
                    onChange={(e) => setNewHandle(e.target.value)}
                    className="text-[10px] border border-gray-200 px-1.5 py-0.5 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-0 w-28"
                />
                <select
                    value={newKind}
                    onChange={(e) => setNewKind(e.target.value as AdminBulkEngagementKind)}
                    className="text-[10px] border border-gray-200 px-1 py-0.5 bg-white"
                >
                    <option value="save">Saved</option>
                    <option value="going">Going</option>
                </select>
                <select
                    value={newAudience}
                    onChange={(e) =>
                        setNewAudience(e.target.value as '' | AdminBulkEngagementAudience)
                    }
                    className="text-[10px] border border-gray-200 px-1 py-0.5 bg-white"
                >
                    <option value="">default</option>
                    <option value="public">public</option>
                    <option value="friends">friends</option>
                    <option value="private">private</option>
                </select>
                <button
                    onClick={handleAdd}
                    disabled={saving || !newHandle.trim()}
                    className="text-[10px] font-medium px-2 py-0.5 bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                    {saving ? '…' : 'Add'}
                </button>
            </div>
        </div>
    );
}
