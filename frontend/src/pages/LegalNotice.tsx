import LegalDocument, { Bullets, type LegalVersion } from '../components/LegalDocument';
import { SUPPORT_EMAIL } from '../utils/report';

const mail = <a href={`mailto:${SUPPORT_EMAIL}`} className="text-action underline">{SUPPORT_EMAIL}</a>;

const hosts = [
    'Cloudflare, Inc. — website and images — 101 Townsend St, San Francisco, CA 94107, USA — +1 650 319 8930 — cloudflare.com',
    'Fly.io, Inc. — application servers (Paris region) — 2261 Market Street #4990, San Francisco, CA 94114, USA — support@fly.io — fly.io',
    'Neon, LLC (Databricks, Inc.) — database — 160 Spear Street, Suite 1300, San Francisco, CA 94105, USA — +1 866 330 0121 — neon.com',
];

const en: LegalVersion = {
    title: 'Legal notice',
    updated: 'Last updated: October 2026',
    sections: [
        {
            title: 'Publisher',
            body: (
                <Bullets items={[
                    'Movida — joinmovida.com',
                    'Published by: Ouissam Gouni, individual, non-professional publisher',
                    'Postal contact details have been provided to the hosting provider and are available to the authorities on request.',
                    <>Email: {mail}</>,
                    'Publication director: Ouissam Gouni',
                ]} />
            ),
        },
        { title: 'Hosting', body: <Bullets items={hosts} /> },
        {
            title: 'Contact point and reports',
            body: (
                <p>
                    Single point of contact for users and authorities (EU Digital Services Act, Art. 11–12): {mail}, in English or French.
                    To report illegal content or ask for an event or image to be corrected or removed, use the &ldquo;Report&rdquo; links in the app or write to the same address.
                </p>
            ),
        },
    ],
};

const fr: LegalVersion = {
    title: 'Mentions légales',
    updated: 'Dernière mise à jour : octobre 2026',
    sections: [
        {
            title: 'Éditeur',
            body: (
                <Bullets items={[
                    'Movida — joinmovida.com',
                    'Édité par : Ouissam Gouni, particulier, éditeur non professionnel',
                    'Les coordonnées postales ont été communiquées à l’hébergeur et sont accessibles aux autorités sur demande (LCEN, art. 6).',
                    <>E-mail : {mail}</>,
                    'Directeur de la publication : Ouissam Gouni',
                ]} />
            ),
        },
        { title: 'Hébergement', body: <Bullets items={hosts} /> },
        {
            title: 'Point de contact et signalements',
            body: (
                <p>
                    Point de contact unique pour les utilisateurs et les autorités (règlement européen sur les services numériques, art. 11–12) : {mail},
                    en français ou en anglais. Pour signaler un contenu illicite ou demander la correction ou le retrait d&rsquo;un événement ou d&rsquo;une image,
                    utilisez les liens « Report » de l&rsquo;application ou écrivez à la même adresse.
                </p>
            ),
        },
    ],
};

export default function LegalNotice() {
    return <LegalDocument en={en} fr={fr} />;
}
