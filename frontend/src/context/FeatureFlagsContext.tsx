import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { fetchSettings } from '../api';

export const DEFAULT_EVENT_COLOR_BAR_COLOR = '#64748b';

interface FeatureFlags {
    showPrices: boolean;
    showPopularity: boolean;
    showRatings: boolean;
    popularityThreshold: number;
    // Adoption-boost tracks (mirror the server-side site settings).
    followingBadgeEnabled: boolean;
    unseenStateEnabled: boolean;
    trendingEnabled: boolean;
    trendingFloorGoing: number;
    eventColorBarColor: string;
    tagSortMode: 'group' | 'event_count';
}

const defaultFlags: FeatureFlags = {
    showPrices: false,
    showPopularity: false,
    showRatings: false,
    popularityThreshold: 10,
    followingBadgeEnabled: false,
    unseenStateEnabled: false,
    trendingEnabled: false,
    trendingFloorGoing: 3,
    eventColorBarColor: DEFAULT_EVENT_COLOR_BAR_COLOR,
    tagSortMode: 'group',
};

const FeatureFlagsContext = createContext<FeatureFlags>(defaultFlags);

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
    const [flags, setFlags] = useState<FeatureFlags>(defaultFlags);

    useEffect(() => {
        fetchSettings()
            .then((s) => {
                setFlags({
                    showPrices: s.show_prices,
                    showPopularity: s.show_popularity,
                    showRatings: s.show_ratings,
                    popularityThreshold: s.popularity_threshold,
                    followingBadgeEnabled: s.following_badge_enabled ?? false,
                    unseenStateEnabled: s.unseen_state_enabled ?? false,
                    trendingEnabled: s.trending_enabled ?? false,
                    trendingFloorGoing: s.trending_floor_going ?? 3,
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
