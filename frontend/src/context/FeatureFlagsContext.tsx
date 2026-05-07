import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { fetchSettings } from '../api';

export const DEFAULT_EVENT_COLOR_BAR_COLOR = '#64748b';

interface FeatureFlags {
    showPrices: boolean;
    showPopularity: boolean;
    showRatings: boolean;
    popularityThreshold: number;
    eventColorBarColor: string;
    tagSortMode: 'group' | 'event_count';
}

const FeatureFlagsContext = createContext<FeatureFlags>({
    showPrices: false,
    showPopularity: false,
    showRatings: false,
    popularityThreshold: 10,
    eventColorBarColor: DEFAULT_EVENT_COLOR_BAR_COLOR,
    tagSortMode: 'group',
});

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
    const [flags, setFlags] = useState<FeatureFlags>({
        showPrices: false,
        showPopularity: false,
        showRatings: false,
        popularityThreshold: 10,
        eventColorBarColor: DEFAULT_EVENT_COLOR_BAR_COLOR,
        tagSortMode: 'group',
    });

    useEffect(() => {
        fetchSettings()
            .then((s) => {
                setFlags({
                    showPrices: s.show_prices,
                    showPopularity: s.show_popularity,
                    showRatings: s.show_ratings,
                    popularityThreshold: s.popularity_threshold,
                    eventColorBarColor: s.event_color_bar_color || DEFAULT_EVENT_COLOR_BAR_COLOR,
                    tagSortMode: s.tag_sort_mode === 'event_count' ? 'event_count' : 'group',
                });
            })
            .catch(() => {
                // Keep defaults on error
            });
    }, []);

    return (
        <FeatureFlagsContext.Provider value={flags}>
            {children}
        </FeatureFlagsContext.Provider>
    );
}

export function useFeatureFlags(): FeatureFlags {
    return useContext(FeatureFlagsContext);
}
