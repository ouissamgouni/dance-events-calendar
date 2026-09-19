import { useState } from 'react';
import SubPage from './SubPage';
import { btnPrimary, errorCls, fieldLabelCls, inputCls, isUrlValid, type LinkRow } from './formState';

interface Props {
    /** The link being edited, or null when adding a new one. */
    value: LinkRow | null;
    onSave: (link: LinkRow) => void;
    onClose: () => void;
}

/** Full-screen editor for a single link. Confirms with Save, never Submit. */
export default function LinkPage({ value, onSave, onClose }: Props) {
    const [url, setUrl] = useState(value?.url ?? '');
    const [label, setLabel] = useState(value?.label ?? '');
    const [touched, setTouched] = useState(false);

    const trimmed = url.trim();
    const invalid = trimmed.length > 0 && !isUrlValid(trimmed);

    const save = () => {
        setTouched(true);
        if (!trimmed || invalid) return;
        onSave({ url: trimmed, label: label.trim() });
        onClose();
    };

    return (
        <SubPage
            title={value ? 'Edit link' : 'Add link'}
            onBack={onClose}
            footer={
                <button type="button" className={btnPrimary} onClick={save} disabled={!trimmed || invalid}>
                    Save
                </button>
            }
        >
            <label className={fieldLabelCls} htmlFor="link-url">
                URL
            </label>
            <input
                id="link-url"
                type="url"
                inputMode="url"
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => setTouched(true)}
                placeholder="https://"
                className={inputCls}
            />

            <label className={`${fieldLabelCls} mt-4`} htmlFor="link-label">
                Label (optional)
            </label>
            <input
                id="link-label"
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Tickets"
                className={inputCls}
            />

            {touched && invalid ? <p className={errorCls}>Enter a valid http(s) link.</p> : null}
        </SubPage>
    );
}
