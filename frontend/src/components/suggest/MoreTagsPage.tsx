import { useState } from 'react';
import { Search } from 'lucide-react';
import SubPage from './SubPage';
import type { TagGroup } from '../../types';
import type { TagsPickerValue } from '../TagsPicker';
import { btnPrimary, chipCls, helpCls, inputCls, sectionLabelCls } from './formState';

interface Props {
    groups: TagGroup[];
    value: TagsPickerValue;
    onChange: (value: TagsPickerValue) => void;
    onClose: () => void;
}

/**
 * Full-screen picker for the optional tag groups. Selections apply immediately
 * — `Done` just closes the page, keeping `Submit Event` out of reach.
 */
export default function MoreTagsPage({ groups, value, onChange, onClose }: Props) {
    const [query, setQuery] = useState('');
    const needle = query.trim().toLowerCase();

    const toggle = (group: TagGroup, tagId: number) => {
        const selected = value.selectedTagIds.includes(tagId);
        let next: number[];
        if (selected) {
            next = value.selectedTagIds.filter((id) => id !== tagId);
        } else if (group.allow_multiple) {
            next = [...value.selectedTagIds, tagId];
        } else {
            // Single-select group: drop any other tag from the same group.
            const siblings = new Set(group.tags.map((t) => t.id));
            next = [...value.selectedTagIds.filter((id) => !siblings.has(id)), tagId];
        }
        onChange({ ...value, selectedTagIds: next });
    };

    const visible = groups
        .map((g) => ({
            group: g,
            tags: needle ? g.tags.filter((t) => t.label.toLowerCase().includes(needle)) : g.tags,
        }))
        .filter((g) => g.tags.length > 0);
    const exactMatch = groups.some((g) => g.tags.some((t) => t.label.toLowerCase() === needle));
    const requested = Object.entries(value.freeTexts).filter(([, text]) => text.trim());
    const groupLabel = (slug: string) => groups.find((g) => g.slug === slug)?.label ?? slug;

    const requestTag = (slug: string) => {
        onChange({ ...value, freeTexts: { ...value.freeTexts, [slug]: query.trim() } });
        setQuery('');
    };
    const dropRequest = (slug: string) => {
        const next = { ...value.freeTexts };
        delete next[slug];
        onChange({ ...value, freeTexts: next });
    };

    return (
        <SubPage
            title="More tags"
            onBack={onClose}
            footer={
                <button type="button" className={btnPrimary} onClick={onClose}>
                    Done
                </button>
            }
        >
            <div className="relative">
                <Search
                    size={18}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
                    aria-hidden="true"
                />
                <input
                    type="search"
                    aria-label="Search tags"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search tags"
                    className={`${inputCls} pl-10`}
                />
            </div>

            {visible.length === 0 ? <p className={helpCls}>No tags match “{query.trim()}”.</p> : null}

            {needle && !exactMatch && groups.length > 0 ? (
                <div className="mt-3" data-testid="request-new-tag">
                    <span className={sectionLabelCls}>Suggest “{query.trim()}” as a new tag in</span>
                    <div className="flex flex-wrap gap-2">
                        {groups.map((g) => (
                            <button key={g.id} type="button" onClick={() => requestTag(g.slug)} className={chipCls(false)}>
                                + {g.label}
                            </button>
                        ))}
                    </div>
                    <p className={helpCls}>A curator reviews new tags before they appear.</p>
                </div>
            ) : null}

            {requested.length > 0 ? (
                <div className="mt-3">
                    <span className={sectionLabelCls}>New tags you suggested</span>
                    <div className="flex flex-wrap gap-2">
                        {requested.map(([slug, text]) => (
                            <button
                                key={slug}
                                type="button"
                                onClick={() => dropRequest(slug)}
                                aria-label={`Remove new tag ${text}`}
                                className={chipCls(true)}
                            >
                                {text} · {groupLabel(slug)} ✕
                            </button>
                        ))}
                    </div>
                </div>
            ) : null}

            <div className="mt-4 space-y-5">
                {visible.map(({ group, tags }) => (
                    <div key={group.id}>
                        <span className={sectionLabelCls}>{group.label}</span>
                        <div className="flex flex-wrap gap-2">
                            {tags.map((tag) => {
                                const on = value.selectedTagIds.includes(tag.id);
                                return (
                                    <button
                                        key={tag.id}
                                        type="button"
                                        aria-pressed={on}
                                        onClick={() => toggle(group, tag.id)}
                                        className={chipCls(on)}
                                    >
                                        {tag.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        </SubPage>
    );
}
