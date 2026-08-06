import PreferencesSection from '../components/PreferencesSection';

/** /mine/profiles — "Discovery Profiles": the saved area + tag alert/search
 * profiles that seed Explorer and For You. Extracted from the old Settings
 * "Preferences" section. */
export default function DiscoveryProfilesPage() {
    return (
        <div className="mx-auto max-w-xl px-4 py-4 text-xs">
            <PreferencesSection />
        </div>
    );
}
