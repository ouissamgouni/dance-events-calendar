import type { MonthlyActivity } from '../types';
import { activityLevel, rollingTwelveMonths } from '../utils/passportActivity';

const ACTIVITY_CLASSES: Record<0 | 1 | 2 | 3 | 4, string> = {
    0: 'bg-white/10',
    1: 'bg-white/25',
    2: 'bg-white/45',
    3: 'bg-white/65',
    4: 'bg-white/90',
};

export default function MyDanceActivityStrip({ months }: { months: MonthlyActivity[] }) {
    const rolling = rollingTwelveMonths(months);

    return (
        <div className="grid grid-cols-12 gap-2" aria-label="Attended events in the last 12 months">
            {rolling.map((month) => (
                <div key={month.month} className="min-w-0 text-center">
                    <span className="block text-[11px] font-medium text-white/80" aria-hidden="true">
                        {month.initial}
                    </span>
                    <span
                        className={`mt-1.5 block aspect-square w-full rounded-[4px] ${ACTIVITY_CLASSES[activityLevel(month.count)]}`}
                        role="img"
                        aria-label={`${month.count} ${month.count === 1 ? 'event' : 'events'} in ${month.month}`}
                    />
                </div>
            ))}
        </div>
    );
}
