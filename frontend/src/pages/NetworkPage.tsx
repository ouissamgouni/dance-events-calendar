import NetworkPanel from '../components/NetworkPanel';

/** /tribe/network — the viewer's follow graph (followers / following / friends
 * / suggestions / leaderboard). Extracted from the old Settings "My network"
 * section. */
export default function NetworkPage() {
    return (
        <div className="mx-auto max-w-3xl px-4 py-4">
            <div className="bg-surface">
                <NetworkPanel />
            </div>
        </div>
    );
}
