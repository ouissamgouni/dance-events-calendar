import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';

export interface LegalSection {
    title: string;
    body: ReactNode;
}

export interface LegalVersion {
    title: string;
    updated: string;
    sections: LegalSection[];
}

type Lang = 'en' | 'fr';

function initialLang(): Lang {
    return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/** Shared layout for the Privacy, Terms and Legal notice pages (EN + FR). */
export default function LegalDocument({ en, fr }: { en: LegalVersion; fr: LegalVersion }) {
    const [lang, setLang] = useState<Lang>(initialLang);
    const doc = lang === 'fr' ? fr : en;

    return (
        <>
            <Helmet>
                <title>{doc.title} – Movida</title>
            </Helmet>
            <article className="mx-auto max-w-3xl px-4 py-8 text-ink">
                <div className="mb-6 flex items-center justify-between gap-4">
                    <Link to="/" className="text-sm text-action hover:underline">
                        ← {lang === 'fr' ? 'Retour' : 'Back'}
                    </Link>
                    <div role="group" aria-label="Language" className="flex gap-1 text-xs">
                        {(['en', 'fr'] as const).map((code) => (
                            <button
                                key={code}
                                type="button"
                                aria-pressed={lang === code}
                                onClick={() => setLang(code)}
                                className={`rounded-field border px-2 py-1 ${lang === code ? 'border-action bg-action text-white' : 'border-line bg-surface text-ink hover:bg-canvas'}`}
                            >
                                {code.toUpperCase()}
                            </button>
                        ))}
                    </div>
                </div>
                <h1 className="mb-2 text-2xl font-bold">{doc.title}</h1>
                <p className="mb-8 text-sm text-ink-soft">{doc.updated}</p>
                {doc.sections.map((section) => (
                    <section key={section.title} className="mb-8 space-y-2 text-sm leading-6">
                        <h2 className="text-lg font-semibold">{section.title}</h2>
                        {section.body}
                    </section>
                ))}
                <nav aria-label="Legal" className="mt-10 flex flex-wrap gap-4 border-t border-line pt-4 text-xs text-ink-soft">
                    <Link to="/privacy" className="hover:text-ink">{lang === 'fr' ? 'Confidentialité' : 'Privacy'}</Link>
                    <Link to="/terms" className="hover:text-ink">{lang === 'fr' ? 'Conditions' : 'Terms'}</Link>
                    <Link to="/legal" className="hover:text-ink">{lang === 'fr' ? 'Mentions légales' : 'Legal notice'}</Link>
                </nav>
            </article>
        </>
    );
}

export function Bullets({ items }: { items: ReactNode[] }) {
    return (
        <ul className="ml-6 list-disc space-y-1">
            {items.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
    );
}
