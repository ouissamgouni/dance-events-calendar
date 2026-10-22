import { useEffect, useState } from 'react';
import { fetchSeriesDetectionSettings, updateSeriesDetectionSettings } from '../api';
import type { SeriesDetectionSettings } from '../types';

type NumberKey = 'title_similarity_pct' | 'max_gap_days' | 'venue_radius_m' | 'max_distance_km';
type BoolKey = 'auto_detect_enabled' | 'cross_calendar_enabled' | 'join_resolved_enabled';

const NUMBER_FIELDS: { key: NumberKey; label: string; min: number; max: number }[] = [
    { key: 'title_similarity_pct', label: 'Title similarity (%)', min: 50, max: 100 },
    { key: 'max_gap_days', label: 'Max gap between occurrences (days)', min: 1, max: 730 },
    { key: 'venue_radius_m', label: 'Same-venue radius (m)', min: 0, max: 5000 },
    { key: 'max_distance_km', label: 'Never match beyond (km)', min: 1, max: 1000 },
];

const BOOL_FIELDS: { key: BoolKey; label: string }[] = [
    { key: 'auto_detect_enabled', label: 'Detect automatically on sync/edit' },
    { key: 'cross_calendar_enabled', label: 'Match events across calendars' },
    { key: 'join_resolved_enabled', label: 'Add new occurrences to approved series (reopens them for review)' },
];

export default function SeriesDetectionSettingsForm() {
    const [form, setForm] = useState<SeriesDetectionSettings | null>(null);
    const [words, setWords] = useState('');
    const [numbers, setNumbers] = useState<Record<NumberKey, string>>({
        title_similarity_pct: '',
        max_gap_days: '',
        venue_radius_m: '',
        max_distance_km: '',
    });
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const apply = (s: SeriesDetectionSettings) => {
        setForm(s);
        setWords(s.generic_title_words.join(', '));
        setNumbers({
            title_similarity_pct: String(s.title_similarity_pct),
            max_gap_days: String(s.max_gap_days),
            venue_radius_m: String(s.venue_radius_m),
            max_distance_km: String(s.max_distance_km),
        });
    };

    useEffect(() => {
        fetchSeriesDetectionSettings()
            .then(apply)
            .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load settings'));
    }, []);

    if (!form) {
        return <div className="p-6 text-center text-xs text-muted">{error ?? 'Loading…'}</div>;
    }

    const fieldErrors = Object.fromEntries(
        NUMBER_FIELDS.map(({ key, min, max }) => {
            const n = Number(numbers[key]);
            const ok = numbers[key] !== '' && Number.isInteger(n) && n >= min && n <= max;
            return [key, ok ? null : `Enter a whole number between ${min} and ${max}`];
        }),
    ) as Record<NumberKey, string | null>;
    const invalid = Object.values(fieldErrors).some(Boolean);

    const save = async () => {
        setSaving(true);
        setSaved(false);
        setError(null);
        try {
            const updated = await updateSeriesDetectionSettings({
                ...form,
                title_similarity_pct: Number(numbers.title_similarity_pct),
                max_gap_days: Number(numbers.max_gap_days),
                venue_radius_m: Number(numbers.venue_radius_m),
                max_distance_km: Number(numbers.max_distance_km),
                generic_title_words: words.split(','),
            });
            apply(updated);
            setSaved(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save settings');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="p-4 space-y-4 text-xs text-ink">
            <p className="text-ink-soft">
                Used by "Scan now" and automatic detection. Changes apply to the next scan.
            </p>
            {BOOL_FIELDS.map(({ key, label }) => (
                <label key={key} className="flex items-center gap-2">
                    <input
                        type="checkbox"
                        checked={form[key]}
                        onChange={(e) => {
                            setSaved(false);
                            setForm({ ...form, [key]: e.target.checked });
                        }}
                    />
                    {label}
                </label>
            ))}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {NUMBER_FIELDS.map(({ key, label, min, max }) => (
                    <label key={key} className="block">
                        <span className="block mb-1 text-ink-soft">{label}</span>
                        <input
                            type="number"
                            min={min}
                            max={max}
                            value={numbers[key]}
                            aria-invalid={Boolean(fieldErrors[key])}
                            onChange={(e) => {
                                setSaved(false);
                                setNumbers({ ...numbers, [key]: e.target.value });
                            }}
                            className="w-full border border-line px-2 py-1"
                        />
                        {fieldErrors[key] && (
                            <span className="block mt-1 text-[11px] text-danger">{fieldErrors[key]}</span>
                        )}
                    </label>
                ))}
            </div>
            <label className="block">
                <span className="block mb-1 text-ink-soft">
                    Generic title words, ignored when comparing titles (comma-separated)
                </span>
                <textarea
                    rows={4}
                    value={words}
                    onChange={(e) => {
                        setSaved(false);
                        setWords(e.target.value);
                    }}
                    className="w-full border border-line px-2 py-1"
                />
            </label>
            {error && <div className="text-danger">{error}</div>}
            <div className="flex items-center gap-3">
                <button
                    onClick={save}
                    disabled={saving || invalid}
                    className="bg-action text-white px-3 py-1.5 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {saving ? 'Saving…' : 'Save settings'}
                </button>
                {saved && <span className="text-ink-soft">Saved</span>}
            </div>
        </div>
    );
}
