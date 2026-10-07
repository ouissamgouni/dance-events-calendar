import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import LegalDocument, { Bullets, type LegalVersion } from '../components/LegalDocument';
import { useConsent } from '../context/ConsentContext';
import { SUPPORT_EMAIL } from '../utils/report';

const mail = <a href={`mailto:${SUPPORT_EMAIL}`} className="text-action underline">{SUPPORT_EMAIL}</a>;

function versions(manageCookies: ReactNode): { en: LegalVersion; fr: LegalVersion } {
    const en: LegalVersion = {
        title: 'Privacy Policy',
        updated: 'Last updated: October 2026',
        sections: [
            {
                title: '1. Who we are',
                body: (
                    <p>
                        Movida (joinmovida.com) is a community calendar for social dance events (salsa, bachata, kizomba, zouk…),
                        run by Ouissam Gouni, an individual (&ldquo;we&rdquo;). We are the data controller. Contact: {mail}.
                        Movida is free, is not funded by advertising, and we never sell your data.
                    </p>
                ),
            },
            {
                title: '2. What we collect and why',
                body: (
                    <Bullets items={[
                        <><strong>Your account</strong> (if you sign up): email address, name, profile photo, Google account ID if you use
                            &ldquo;Sign in with Google&rdquo;, your handle, and anything you add to your profile (bio, social links, &ldquo;dancing since&rdquo;).
                            Legal basis: performing our contract with you (GDPR Art. 6(1)(b)).</>,
                        <><strong>What you do in Movida</strong>: events you save or mark &ldquo;I&rsquo;m going&rdquo; and who may see that, people you follow,
                            reviews, event messages, events and promo codes you submit, your Dance Passport, saved searches, preferred area,
                            notification settings and timezone. Legal basis: contract.</>,
                        <><strong>Tickets and memory photos</strong> you upload: stored in a private storage space; photos are re-encoded and their
                            location metadata (EXIF/GPS) removed; tickets are deleted automatically 30 days after the event. Legal basis: contract.</>,
                        <><strong>Notifications</strong>: your email address for reminders and digests, and your device&rsquo;s push subscription if you turn
                            push on. You can switch each type off in Settings. Legal basis: contract.</>,
                        <><strong>Without an account</strong>: saves and &ldquo;I&rsquo;m going&rdquo; are kept against a random device identifier
                            (cookie <code>movida_aid</code> and local storage) so they survive a reload. This is strictly necessary for the feature you use.</>,
                        <><strong>Analytics &mdash; only with your consent</strong>: which events are viewed, clicked or exported and from which screen, plus page statistics via Umami. If you also accept
                            personalisation cookies, these events are linked to a random device identifier. Legal basis: consent (Art. 6(1)(a)); nothing is sent without it.</>,
                        <><strong>Security</strong>: the IP address of email sign-in code requests (deleted about a day after the code expires), temporary
                            IP-based rate limiting, and the browser type of your last visit. Legal basis: our legitimate interest in keeping Movida safe (Art. 6(1)(f)).</>,
                        <><strong>Messages you send us</strong> at {mail}.</>,
                    ]} />
                ),
            },
            {
                title: '3. What we don’t do',
                body: <p>No advertising trackers, no sale of data, no IP-based location tracking, no profiling with legal effects.</p>,
            },
            {
                title: '4. Who can see what',
                body: (
                    <Bullets items={[
                        'Your profile (name, handle, photo, bio, links, followers) is public by default. You can make it friends-only in Settings.',
                        'Each save or “I’m going” has its own audience (public, friends or only me), which you pick when you tap it.',
                        'Your Dance Passport is visible to friends by default; share links only exist if you create them, and you can revoke them.',
                        'Reviews show your name unless you post anonymously. Event messages are visible to other members.',
                    ]} />
                ),
            },
            {
                title: '5. Service providers',
                body: (
                    <>
                        <p>We use these processors, under contracts that require them to protect your data:</p>
                        <Bullets items={[
                            'Cloudflare (website delivery, image storage)',
                            'Fly.io (application servers, Paris region)',
                            'Neon (database)',
                            'Brevo (sending emails)',
                            'Google (Sign in with Google; geocoding of event addresses)',
                            'OpenStreetMap / CARTO (map tiles — your browser loads them directly, so they see your IP address) and Nominatim (address search text sent from our servers)',
                            'Umami Cloud (analytics, only with consent)',
                            'Your browser’s push service (Apple, Google or Mozilla) if you enable push notifications',
                        ]} />
                        <p>
                            Some providers are based in the United States. Those transfers rely on the EU–US Data Privacy Framework
                            and/or the European Commission&rsquo;s Standard Contractual Clauses.
                        </p>
                    </>
                ),
            },
            {
                title: '6. How long we keep data',
                body: (
                    <Bullets items={[
                        'Account data: until you delete your account.',
                        'When you delete your account we erase your profile, saves, “I’m going”, follows, share links, push subscriptions, notifications, tickets and memories. Reviews stay, anonymised, so event ratings remain consistent; event messages and event suggestions stay without your name or email.',
                        'Analytics: the link to your device identifier is removed after 12 months.',
                        'Sign-in codes: deleted about a day after they expire.',
                        'Database backups held by our provider are overwritten automatically after a short period.',
                    ]} />
                ),
            },
            {
                title: '7. Your rights',
                body: (
                    <>
                        <p>
                            You can access, correct, delete or export your data, restrict or object to its use, and withdraw consent at any
                            time. Delete your account in <Link to="/account" className="text-action underline">Settings</Link>; for anything else
                            email {mail} &mdash; we answer within one month. You can also complain to a data protection authority, such as the
                            CNIL in France (cnil.fr) or the one where you live.
                        </p>
                        {manageCookies}
                    </>
                ),
            },
            {
                title: '8. Cookies and local storage',
                body: (
                    <Bullets items={[
                        <><code>session_token</code>: keeps you signed in (7 days, strictly necessary).</>,
                        <><code>movida_aid</code>: random device identifier for saves without an account (2 years, strictly necessary).</>,
                        <><code>cc_cookie</code>: remembers your cookie choices (6 months).</>,
                        'Local storage: preferences, offline cache, and dismissed prompts.',
                        'Umami analytics and device-linked analytics: only after you accept analytics.',
                    ]} />
                ),
            },
            {
                title: '9. Age',
                body: <p>Movida is for people aged 16 and over.</p>,
            },
            {
                title: '10. Changes',
                body: <p>We will update the date above and tell you in the app or by email about any significant change.</p>,
            },
        ],
    };

    const fr: LegalVersion = {
        title: 'Politique de confidentialité',
        updated: 'Dernière mise à jour : octobre 2026',
        sections: [
            {
                title: '1. Qui sommes-nous ?',
                body: (
                    <p>
                        Movida (joinmovida.com) est un calendrier communautaire d&rsquo;événements de danse sociale (salsa, bachata, kizomba, zouk…),
                        édité par Ouissam Gouni, particulier (« nous »). Nous sommes responsables du traitement. Contact : {mail}.
                        Movida est gratuit, n&rsquo;est pas financé par la publicité, et nous ne vendons jamais vos données.
                    </p>
                ),
            },
            {
                title: '2. Données collectées et finalités',
                body: (
                    <Bullets items={[
                        <><strong>Votre compte</strong> (si vous vous inscrivez) : adresse e-mail, nom, photo de profil, identifiant Google si vous utilisez
                            « Se connecter avec Google », votre pseudo et ce que vous ajoutez à votre profil (bio, liens, « je danse depuis »).
                            Base légale : exécution du contrat (RGPD art. 6(1)(b)).</>,
                        <><strong>Votre activité</strong> : événements enregistrés ou marqués « J&rsquo;y vais » et qui peut le voir, personnes suivies, avis,
                            messages, événements et codes promo proposés, Dance Passport, recherches enregistrées, zone préférée, réglages de notification et fuseau horaire.
                            Base légale : contrat.</>,
                        <><strong>Billets et photos souvenirs</strong> : stockés dans un espace privé ; les photos sont ré-encodées et leurs métadonnées de
                            localisation (EXIF/GPS) supprimées ; les billets sont supprimés automatiquement 30 jours après l&rsquo;événement. Base légale : contrat.</>,
                        <><strong>Notifications</strong> : votre e-mail pour les rappels et récapitulatifs, et l&rsquo;abonnement push de votre appareil si vous l&rsquo;activez.
                            Chaque type peut être désactivé dans les Réglages. Base légale : contrat.</>,
                        <><strong>Sans compte</strong> : vos enregistrements et « J&rsquo;y vais » sont liés à un identifiant aléatoire d&rsquo;appareil
                            (cookie <code>movida_aid</code> et stockage local). C&rsquo;est strictement nécessaire à la fonctionnalité utilisée.</>,
                        <><strong>Mesure d&rsquo;audience — uniquement avec votre consentement</strong> : événements consultés, cliqués ou exportés et depuis quel écran,
                            ainsi que des statistiques de pages via Umami. Si vous acceptez aussi les cookies de personnalisation, ces événements sont liés à un identifiant aléatoire. Base légale : consentement (art. 6(1)(a)).</>,
                        <><strong>Sécurité</strong> : adresse IP des demandes de code de connexion par e-mail (supprimée environ un jour après expiration du code),
                            limitation temporaire du débit par IP, et type de navigateur de votre dernière visite. Base légale : intérêt légitime à sécuriser le service (art. 6(1)(f)).</>,
                        <><strong>Vos messages</strong> envoyés à {mail}.</>,
                    ]} />
                ),
            },
            {
                title: '3. Ce que nous ne faisons pas',
                body: <p>Aucun traceur publicitaire, aucune vente de données, aucune localisation par adresse IP, aucun profilage produisant des effets juridiques.</p>,
            },
            {
                title: '4. Qui voit quoi',
                body: (
                    <Bullets items={[
                        'Votre profil (nom, pseudo, photo, bio, liens, abonnés) est public par défaut. Vous pouvez le limiter à vos amis dans les Réglages.',
                        'Chaque enregistrement ou « J’y vais » a sa propre audience (public, amis ou moi seul), choisie au moment où vous l’ajoutez.',
                        'Votre Dance Passport est visible par vos amis par défaut ; un lien de partage n’existe que si vous le créez, et vous pouvez le révoquer.',
                        'Les avis affichent votre nom sauf si vous publiez anonymement. Les messages sur les événements sont visibles par les autres membres.',
                    ]} />
                ),
            },
            {
                title: '5. Sous-traitants',
                body: (
                    <>
                        <p>Nous faisons appel aux sous-traitants suivants, tenus contractuellement de protéger vos données :</p>
                        <Bullets items={[
                            'Cloudflare (diffusion du site, stockage des images)',
                            'Fly.io (serveurs applicatifs, région Paris)',
                            'Neon (base de données)',
                            'Brevo (envoi des e-mails)',
                            'Google (connexion avec Google ; géocodage des adresses d’événements)',
                            'OpenStreetMap / CARTO (fonds de carte — votre navigateur les charge directement et ils voient votre adresse IP) et Nominatim (texte de recherche d’adresse envoyé depuis nos serveurs)',
                            'Umami Cloud (mesure d’audience, uniquement avec consentement)',
                            'Le service push de votre navigateur (Apple, Google ou Mozilla) si vous activez les notifications',
                        ]} />
                        <p>
                            Certains prestataires sont établis aux États-Unis. Ces transferts reposent sur le Data Privacy Framework UE–États-Unis
                            et/ou les clauses contractuelles types de la Commission européenne.
                        </p>
                    </>
                ),
            },
            {
                title: '6. Durées de conservation',
                body: (
                    <Bullets items={[
                        'Données du compte : jusqu’à la suppression de votre compte.',
                        'À la suppression du compte, nous effaçons votre profil, vos enregistrements, « J’y vais », abonnements, liens de partage, abonnements push, notifications, billets et souvenirs. Les avis sont conservés de façon anonyme pour garder des notes cohérentes ; les messages et propositions d’événements sont conservés sans votre nom ni e-mail.',
                        'Mesure d’audience : le lien avec l’identifiant d’appareil est supprimé après 12 mois.',
                        'Codes de connexion : supprimés environ un jour après leur expiration.',
                        'Sauvegardes de la base de données chez notre prestataire : écrasées automatiquement après une courte période.',
                    ]} />
                ),
            },
            {
                title: '7. Vos droits',
                body: (
                    <>
                        <p>
                            Vous pouvez accéder à vos données, les rectifier, les effacer ou les récupérer, limiter ou vous opposer à leur traitement,
                            et retirer votre consentement à tout moment. Supprimez votre compte dans les <Link to="/account" className="text-action underline">Réglages</Link> ;
                            pour le reste, écrivez à {mail} — nous répondons sous un mois. Vous pouvez aussi saisir la CNIL (cnil.fr) ou l&rsquo;autorité de votre pays.
                        </p>
                        {manageCookies}
                    </>
                ),
            },
            {
                title: '8. Cookies et stockage local',
                body: (
                    <Bullets items={[
                        <><code>session_token</code> : maintient votre connexion (7 jours, strictement nécessaire).</>,
                        <><code>movida_aid</code> : identifiant aléatoire d&rsquo;appareil pour les enregistrements sans compte (2 ans, strictement nécessaire).</>,
                        <><code>cc_cookie</code> : mémorise vos choix de cookies (6 mois).</>,
                        'Stockage local : préférences, cache hors ligne et messages déjà fermés.',
                        'Umami et la mesure d’audience liée à l’appareil : uniquement après acceptation.',
                    ]} />
                ),
            },
            {
                title: '9. Âge',
                body: <p>Movida est réservé aux personnes de 16 ans et plus.</p>,
            },
            {
                title: '10. Modifications',
                body: <p>Nous mettrons à jour la date ci-dessus et vous informerons dans l&rsquo;application ou par e-mail de tout changement important.</p>,
            },
        ],
    };

    return { en, fr };
}

export default function Privacy() {
    const { showPreferences } = useConsent();
    const button = (
        <button
            type="button"
            onClick={showPreferences}
            className="rounded-field border border-line bg-surface px-4 py-2 text-sm text-ink hover:bg-canvas"
        >
            Cookie preferences / Préférences de cookies
        </button>
    );
    const { en, fr } = versions(button);
    return <LegalDocument en={en} fr={fr} />;
}
