import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { fetchSettings } from '../api';

interface FeatureFlags {
    showPrices: boolean;
    showPopularity: boolean;
    popularityThreshold: number;
}

const FeatureFlagsContext = createContext<FeatureFlags>({
    showPrices: false,
    showPopularity: false,
    popularityThreshold: 10,
});

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
    const [flags, setFlags] = useState<FeatureFlags>({
        showPrices: false,
        showPopularity: false,
        popularityThreshold: 10,
    });

    useEffect(() => {
        fetchSettings()
            .then((s) => {
                setFlags({
                    showPrices: s.show_prices,
                    showPopularity: s.show_popularity,
                    popularityThreshold: s.popularity_threshold,
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
