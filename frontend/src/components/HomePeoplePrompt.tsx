import { useCallback, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import BottomSheet from './BottomSheet';
import PeopleSuggestionsTrail from './PeopleSuggestionsTrail';
import { usePeoplePrompt } from '../hooks/usePeoplePrompt';
import { usePeopleSuggestions } from '../hooks/usePeopleSuggestions';
import { useRegisterHomeOverlay } from '../hooks/useHomeOverlays';

interface Props {
    userId: string;
    /** Gates the server check only (after higher-priority prompts settle); once open the sheet stays until closed. */
    enabled: boolean;
}

/** Disposable "Build your tribe" sheet; cadence and forces are decided server-side. */
export default function HomePeoplePrompt({ userId, enabled }: Props) {
    const { prompt, close } = usePeoplePrompt(enabled, userId);
    const people = usePeopleSuggestions(!!prompt);
    const items = people.items ?? prompt?.items ?? null;
    const total = people.items ? people.total : prompt?.total ?? 0;
    const followed = useRef(0);
    const open = !!prompt && !!items && items.length > 0;
    useRegisterHomeOverlay(open);

    const { follow, dismiss: onDismiss } = people;
    const handleFollow = useCallback(async (handle: string) => {
        await follow(handle);
        followed.current += 1;
    }, [follow]);

    const handleClose = useCallback(() => close(followed.current), [close]);

    useEffect(() => {
        if (prompt && items?.length === 0) close(followed.current);
    }, [prompt, items, close]);

    if (!open || !items) return null;
    const subtitle = prompt.friend_count === 0
        ? 'Follow a few dancers to see where they are going.'
        : 'People you may know from your scene.';

    return (
        <BottomSheet
            title="Build your tribe"
            subtitle={subtitle}
            titleSize="large"
            onClose={handleClose}
            desktop="modal"
            footer={(
                <div className="flex items-center justify-between gap-3">
                    <Link to="/tribe/network" onClick={handleClose} className="text-sm font-semibold text-action hover:underline">
                        See all
                    </Link>
                    <button
                        type="button"
                        onClick={handleClose}
                        className="bg-action px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
                    >
                        Done
                    </button>
                </div>
            )}
        >
            <PeopleSuggestionsTrail
                items={items}
                total={total}
                pending={people.pending}
                onFollow={(h) => void handleFollow(h)}
                onDismiss={(h) => void onDismiss(h)}
                showHeader={false}
                testId="home-people-prompt"
            />
        </BottomSheet>
    );
}
