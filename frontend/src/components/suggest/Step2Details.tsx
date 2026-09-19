import { useMemo, useState } from 'react';
import { Link as LinkIcon, Tag as TagIcon, Trash2 } from 'lucide-react';
import type { TagGroup } from '../../types';
import LinkPage from './LinkPage';
import MoreTagsPage from './MoreTagsPage';
import {
    chipCls,
    fieldErrorCls,
    inputCls,
    scrollIntoViewOnFocus,
    sectionLabelCls,
    type LinkRow,
    type PatchState,
    type SuggestFormState,
} from './formState';
import type { FieldError } from './validation';

interface Props {
    state: SuggestFormState;
    patch: PatchState;
    error: FieldError | null;
    danceGroup: TagGroup | null;
    reachGroup: TagGroup | null;
    otherGroups: TagGroup[];
    /** Lets the shell hide its header and footer while a sub-page is open. */
    onSubPageChange: (open: boolean) => void;
}

/** Matches `max_length=3` on EventSuggestionCreate.links in the backend schema. */
const MAX_LINKS = 3;

export default function Step2Details({
    state,
    patch,
    error,
    danceGroup,
    reachGroup,
    otherGroups,
    onSubPageChange,
}: Props) {
    const [page, setPage] = useState<'none' | 'link' | 'tags'>('none');
    const [linkIndex, setLinkIndex] = useState<number | null>(null);

    const errorFor = (field: FieldError['field']) => (error?.field === field ? error.message : null);

    const selectedOtherTags = useMemo(
        () =>
            otherGroups
                .flatMap((g) => g.tags)
                .filter((t) => state.tagsValue.selectedTagIds.includes(t.id)),
        [otherGroups, state.tagsValue.selectedTagIds],
    );

    const openLink = (index: number | null) => {
        setLinkIndex(index);
        setPage('link');
        onSubPageChange(true);
    };
    const openTags = () => {
        setPage('tags');
        onSubPageChange(true);
    };
    const close = () => {
        setPage('none');
        onSubPageChange(false);
    };

    const saveLink = (link: LinkRow) => {
        patch({
            links:
                linkIndex === null
                    ? [...state.links, link]
                    : state.links.map((l, i) => (i === linkIndex ? link : l)),
        });
    };

    const toggleTag = (group: TagGroup, tagId: number) => {
        const selected = state.tagsValue.selectedTagIds.includes(tagId);
        let next: number[];
        if (selected) {
            next = state.tagsValue.selectedTagIds.filter((id) => id !== tagId);
        } else if (group.allow_multiple) {
            next = [...state.tagsValue.selectedTagIds, tagId];
        } else {
            const siblings = new Set(group.tags.map((t) => t.id));
            next = [...state.tagsValue.selectedTagIds.filter((id) => !siblings.has(id)), tagId];
        }
        patch({ tagsValue: { ...state.tagsValue, selectedTagIds: next } });
    };

    if (page === 'link') {
        return (
            <LinkPage
                value={linkIndex === null ? null : state.links[linkIndex]}
                onSave={saveLink}
                onClose={close}
            />
        );
    }

    if (page === 'tags') {
        return (
            <MoreTagsPage
                groups={otherGroups}
                value={state.tagsValue}
                onChange={(tagsValue) => patch({ tagsValue })}
                onClose={close}
            />
        );
    }

    return (
        <div className="space-y-6">
            <textarea
                id="suggest-description"
                aria-label="Description"
                value={state.description}
                onChange={(e) => patch({ description: e.target.value })}
                onFocus={scrollIntoViewOnFocus}
                rows={5}
                placeholder="What should people know about this event?"
                className={inputCls}
            />

            <div id="suggest-links" tabIndex={-1} className="outline-none">
                <span className={sectionLabelCls}>Links</span>
                <ul className="space-y-2">
                    {state.links.map((link, index) => (
                        <li key={index} className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => openLink(index)}
                                className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-field border border-line bg-surface px-4 py-2 text-left transition hover:bg-canvas"
                            >
                                <LinkIcon size={18} className="shrink-0 text-ink-soft" aria-hidden="true" />
                                <span className="min-w-0 truncate text-sm text-ink">
                                    {link.label || link.url}
                                </span>
                            </button>
                            <button
                                type="button"
                                aria-label={`Remove link ${index + 1}`}
                                onClick={() => patch({ links: state.links.filter((_, i) => i !== index) })}
                                className="flex h-11 w-11 shrink-0 items-center justify-center text-muted transition hover:text-danger"
                            >
                                <Trash2 size={16} aria-hidden="true" />
                            </button>
                        </li>
                    ))}
                </ul>
                {state.links.length < MAX_LINKS ? (
                    <button
                        type="button"
                        onClick={() => openLink(null)}
                        className="mt-2 min-h-11 text-sm font-medium text-action"
                    >
                        + Add link
                    </button>
                ) : null}
                {errorFor('links') ? <p className={fieldErrorCls}>{errorFor('links')}</p> : null}
            </div>

            {danceGroup ? (
                <div id="suggest-dance" tabIndex={-1} className="outline-none">
                    <span className={sectionLabelCls}>{danceGroup.label} *</span>
                    {/* One row that scrolls sideways — no "more styles" disclosure. */}
                    <div className="-mx-4 overflow-x-auto px-4">
                        <div className="flex w-max gap-2 pb-1">
                            {danceGroup.tags.map((tag) => (
                                <button
                                    key={tag.id}
                                    type="button"
                                    aria-pressed={state.tagsValue.selectedTagIds.includes(tag.id)}
                                    onClick={() => toggleTag(danceGroup, tag.id)}
                                    className={`shrink-0 ${chipCls(state.tagsValue.selectedTagIds.includes(tag.id))}`}
                                >
                                    {tag.label}
                                </button>
                            ))}
                        </div>
                    </div>
                    {errorFor('danceTags') ? (
                        <p className={fieldErrorCls}>{errorFor('danceTags')}</p>
                    ) : null}
                </div>
            ) : null}

            {reachGroup ? (
                <div id="suggest-reach" tabIndex={-1} className="outline-none">
                    <span className={sectionLabelCls}>{reachGroup.label} *</span>
                    <div className="flex flex-wrap gap-2">
                        {reachGroup.tags.map((tag) => (
                            <button
                                key={tag.id}
                                type="button"
                                aria-pressed={state.tagsValue.selectedTagIds.includes(tag.id)}
                                onClick={() => toggleTag(reachGroup, tag.id)}
                                className={chipCls(state.tagsValue.selectedTagIds.includes(tag.id))}
                            >
                                {tag.label}
                            </button>
                        ))}
                    </div>
                    {errorFor('reachTags') ? (
                        <p className={fieldErrorCls}>{errorFor('reachTags')}</p>
                    ) : null}
                </div>
            ) : null}

            {otherGroups.length > 0 ? (
                <div>
                    {selectedOtherTags.length > 0 ? (
                        // The chips themselves are the entry point once tags exist,
                        // so there is no separate "Add more tags" row.
                        <button
                            type="button"
                            onClick={openTags}
                            aria-label="Edit more tags"
                            className="flex w-full flex-wrap gap-2 rounded-field border border-line bg-surface p-3 text-left transition hover:bg-canvas"
                        >
                            {selectedOtherTags.map((tag) => (
                                <span key={tag.id} className={chipCls(true)}>
                                    {tag.label}
                                </span>
                            ))}
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={openTags}
                            className="flex min-h-12 w-full items-center gap-3 rounded-field border border-line bg-surface px-4 py-2 text-left text-sm font-medium text-action transition hover:bg-canvas"
                        >
                            <TagIcon size={18} className="shrink-0" aria-hidden="true" />
                            Add more tags
                        </button>
                    )}
                </div>
            ) : null}
        </div>
    );
}
