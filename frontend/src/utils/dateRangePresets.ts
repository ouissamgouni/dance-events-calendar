export const DEFAULT_EXPLORER_PERIOD = 'next_3_months' as const;

export const DATE_RANGE_PRESET_CHOICES = [
    { key: 'this_weekend', label: 'This weekend' },
    { key: 'next_weekend', label: 'Next weekend' },
    { key: 'next_7_days', label: 'Next 7 days' },
    { key: 'next_30_days', label: 'Next 30 days' },
    { key: 'next_3_months', label: 'Next 3 months' },
    { key: 'next_6_months', label: 'Next 6 months' },
    { key: 'this_season', label: 'Current season' },
    { key: 'next_season_1', label: 'Next season' },
    { key: 'next_season_2', label: 'Following season' },
    { key: 'next_season_3', label: 'Fourth season' },
] as const;

export type DateRangePresetKey = typeof DATE_RANGE_PRESET_CHOICES[number]['key'];

export interface DateRangePresetOption {
    key: DateRangePresetKey;
    label: string;
    mobileLabel: string;
    start: string;
    end: string;
    group: 'this' | 'next';
    icon?: string;
}

const DATE_RANGE_PRESET_KEY_SET = new Set<string>(
    DATE_RANGE_PRESET_CHOICES.map((choice) => choice.key),
);

export function isDateRangePresetKey(value: string | undefined | null): value is DateRangePresetKey {
    return typeof value === 'string' && DATE_RANGE_PRESET_KEY_SET.has(value);
}

function formatDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
}

function addMonths(date: Date, months: number): Date {
    const next = new Date(date);
    next.setMonth(next.getMonth() + months);
    return next;
}

export function getDateRangePresetOptions(today = new Date()): DateRangePresetOption[] {
    const year = today.getFullYear();
    const dayOfWeek = today.getDay();

    const thisWeekendStart = addDays(today, dayOfWeek === 0 ? -2 : 5 - dayOfWeek);
    const thisWeekendEnd = addDays(thisWeekendStart, 2);
    const nextWeekendStart = addDays(thisWeekendStart, 7);
    const nextWeekendEnd = addDays(nextWeekendStart, 2);
    const next7Days = addDays(today, 7);
    const next30Days = addMonths(today, 1);
    const next3Months = addMonths(today, 3);
    const next6Months = addMonths(today, 6);

    const seasons = [
        { name: 'Spring', icon: '🌸', startMonth: 2, endMonth: 4 },
        { name: 'Summer', icon: '☀️', startMonth: 5, endMonth: 7 },
        { name: 'Autumn', icon: '🍂', startMonth: 8, endMonth: 10 },
        { name: 'Winter', icon: '❄️', startMonth: 11, endMonth: 1 },
    ];

    function seasonRange(idx: number, baseYear: number) {
        const season = seasons[idx];
        if (season.startMonth > season.endMonth) {
            return {
                start: new Date(baseYear, season.startMonth, 1),
                end: new Date(baseYear + 1, season.endMonth + 1, 0),
            };
        }
        return {
            start: new Date(baseYear, season.startMonth, 1),
            end: new Date(baseYear, season.endMonth + 1, 0),
        };
    }

    const month = today.getMonth();
    let currentIdx: number;
    if (month >= 2 && month <= 4) currentIdx = 0;
    else if (month >= 5 && month <= 7) currentIdx = 1;
    else if (month >= 8 && month <= 10) currentIdx = 2;
    else currentIdx = 3;

    const currentBaseYear = (currentIdx === 3 && month <= 1) ? year - 1 : year;
    const currentRange = seasonRange(currentIdx, currentBaseYear);
    const thisSeasonStart = today > currentRange.start ? today : currentRange.start;
    const seasonPresets = Array.from({ length: 4 }, (_, offset): DateRangePresetOption => {
        const seasonIdx = (currentIdx + offset) % 4;
        const seasonBaseYear = currentBaseYear + Math.floor((currentIdx + offset) / 4);
        const range = seasonRange(seasonIdx, seasonBaseYear);
        const season = seasons[seasonIdx];
        const key = offset === 0 ? 'this_season' : `next_season_${offset}` as DateRangePresetKey;

        return {
            key,
            label: season.name,
            mobileLabel: `${season.icon} ${season.name}`,
            icon: season.icon,
            start: formatDate(offset === 0 ? thisSeasonStart : range.start),
            end: formatDate(range.end),
            group: offset === 0 ? 'this' : 'next',
        };
    });

    return [
        { key: 'this_weekend', label: 'Weekend', mobileLabel: 'Wknd', start: formatDate(thisWeekendStart), end: formatDate(thisWeekendEnd), group: 'this' },
        { key: 'next_weekend', label: 'Weekend', mobileLabel: 'Wknd', start: formatDate(nextWeekendStart), end: formatDate(nextWeekendEnd), group: 'next' },
        { key: 'next_7_days', label: '7 days', mobileLabel: '7d', start: formatDate(today), end: formatDate(next7Days), group: 'next' },
        { key: 'next_30_days', label: '30 days', mobileLabel: '30d', start: formatDate(today), end: formatDate(next30Days), group: 'next' },
        { key: 'next_3_months', label: '3 months', mobileLabel: '3mo', start: formatDate(today), end: formatDate(next3Months), group: 'next' },
        { key: 'next_6_months', label: '6 months', mobileLabel: '6mo', start: formatDate(today), end: formatDate(next6Months), group: 'next' },
        ...seasonPresets,
    ];
}

export function getDateRangePresetGroups(today = new Date()) {
    const presets = getDateRangePresetOptions(today);
    return {
        thisPresets: presets.filter((preset) => preset.group === 'this'),
        nextPresets: presets.filter((preset) => preset.group === 'next'),
    };
}

export function getDateRangeForPreset(key: DateRangePresetKey = DEFAULT_EXPLORER_PERIOD): { startDate: string; endDate: string } {
    const preset = getDateRangePresetOptions().find((option) => option.key === key)
        ?? getDateRangePresetOptions().find((option) => option.key === DEFAULT_EXPLORER_PERIOD);
    if (!preset) {
        return { startDate: formatDate(new Date()), endDate: formatDate(addMonths(new Date(), 3)) };
    }
    return { startDate: preset.start, endDate: preset.end };
}
