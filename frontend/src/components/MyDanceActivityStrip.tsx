import type { MonthlyActivity } from '../types';
import { activityLevel, rollingTwelveMonths } from '../utils/passportActivity';

const ACTIVITY_CLASSES: Record<0 | 1 | 2 | 3 | 4, string> = {
    0: 'bg-white/10',
    1: 'bg-white/25',
    2: 'bg-white/45',
    3: 'bg-white/65',
    4: 'bg-white/90',
};

type Size = 'default' | 'small' | 'xs';

interface MyDanceActivityStripProps {
    months: MonthlyActivity[];
    size?: Size;
}

export default function MyDanceActivityStrip({ months, size = 'default' }: MyDanceActivityStripProps) {
    const rolling = rollingTwelveMonths(months);

    const config = size === 'xs'
        ? { gap: 'gap-0', textSize: 'text-[5px]', marginTop: 'mt-0.5', cellSize: 'h-3 w-3' }
        : size === 'small'
            ? { gap: 'gap-0.5', textSize: 'text-[7px]', marginTop: 'mt-0.5', cellSize: 'aspect-square w-full' }
            : { gap: 'gap-2', textSize: 'text-[11px]', marginTop: 'mt-1.5', cellSize: 'aspect-square w-full' };

    return (
        <div
            className={`grid grid-cols-12 ${config.gap}`}
            aria-label="Attended events in the last 12 months"
        >
            {rolling.map((month) => (
                <div key={month.month} className="min-w-0 text-center">
                    <span
                        className={`block font-medium text-white/80 ${config.textSize}`}
                        aria-hidden="true"
                    >
                        {month.initial}
                    </span>
                    <span
                        className={`${config.marginTop} block rounded-[2px] ${config.cellSize} ${ACTIVITY_CLASSES[activityLevel(month.count)]}`}
                        role="img"
                        aria-label={`${month.count} ${month.count === 1 ? 'event' : 'events'} in ${month.month}`}
                    />
                </div>
            ))}
        </div>
    );
}
