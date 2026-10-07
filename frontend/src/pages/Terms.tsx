import { Link } from 'react-router-dom';
import LegalDocument, { Bullets, type LegalVersion } from '../components/LegalDocument';
import { SUPPORT_EMAIL } from '../utils/report';

const mail = <a href={`mailto:${SUPPORT_EMAIL}`} className="text-action underline">{SUPPORT_EMAIL}</a>;
const privacyLink = (label: string) => <Link to="/privacy" className="text-action underline">{label}</Link>;
const legalLink = (label: string) => <Link to="/legal" className="text-action underline">{label}</Link>;

const en: LegalVersion = {
    title: 'Terms of Use & Community Guidelines',
    updated: 'Last updated: October 2026',
    sections: [
        {
            title: '1. About Movida',
            body: (
                <p>
                    Movida is a free community platform to discover social dance events, plan them with friends and keep track of where
                    you&rsquo;ve danced. It is operated by Ouissam Gouni (see the {legalLink('legal notice')}). By using Movida you agree to
                    these Terms and acknowledge our {privacyLink('Privacy Policy')}.
                </p>
            ),
        },
        {
            title: '2. Who can use Movida',
            body: (
                <Bullets items={[
                    'You must be at least 16 years old.',
                    'One person per account. Keep access to your email or Google account secure — you are responsible for what happens on your account.',
                ]} />
            ),
        },
        {
            title: '3. Event information',
            body: (
                <p>
                    Events come from public sources (such as organisers&rsquo; public calendars) and from members&rsquo; submissions. Details can be
                    incomplete or change at short notice: always check with the organiser before you travel or buy a ticket. Movida does not sell
                    tickets and is not a party to any purchase. Promo codes are shared by members or organisers and come with no guarantee.
                </p>
            ),
        },
        {
            title: '4. Your content',
            body: (
                <p>
                    You keep ownership of what you post (reviews, messages, photos, event suggestions, promo codes, profile). You give us a free,
                    non-exclusive, worldwide licence to host, display and technically adapt it (for example resize images) inside Movida for as
                    long as it is online. You confirm you have the right to post it, including the consent of people who appear in your photos.
                </p>
            ),
        },
        {
            title: '5. Community guidelines',
            body: (
                <>
                    <p>Movida is about dancing together. Please:</p>
                    <Bullets items={[
                        'Be respectful. No harassment, hate speech, discrimination, threats or sexual content involving anyone without consent — and never minors.',
                        'Respect privacy: don’t share other people’s personal details or post photos of people who didn’t agree.',
                        'Keep it honest: review only events you know, no fake reviews, and don’t review your own event or rivals’ events to game ratings.',
                        'No spam, unrelated advertising, impersonation or misleading event listings.',
                        'Only post content you have the rights to (photos, flyers, music, logos).',
                        'Don’t scrape, overload, or try to break into Movida.',
                    ]} />
                </>
            ),
        },
        {
            title: '6. Reporting and moderation',
            body: (
                <>
                    <p>
                        Anyone — with or without an account — can report content they believe is illegal or breaks these rules, using the
                        &ldquo;Report&rdquo; links in the app or by email to {mail}. Please include the link, why it should be removed, your name and a statement
                        that your report is made in good faith. Organisers can use &ldquo;Report or request removal&rdquo; on an event page to correct or remove
                        their event or images.
                    </p>
                    <p>
                        We review reports promptly. We may remove content, limit features or suspend accounts that break the law or these rules. Written review
                        comments are checked before they appear. When we remove your content or restrict your account, we tell you why by email, and you can
                        reply to contest the decision.
                    </p>
                </>
            ),
        },
        {
            title: '7. How reviews work',
            body: (
                <p>
                    Reviews can be written by signed-in members once an event is over. Written comments are moderated before publication; attendance is not
                    verified. We never accept payment for reviews and we don&rsquo;t remove a review just because it is negative.
                </p>
            ),
        },
        {
            title: '8. Organisers',
            body: (
                <p>
                    Organiser badges and event claims are granted after a manual check. Organisers are responsible for the accuracy of the information they
                    provide; their changes to public events may be reviewed before they go live.
                </p>
            ),
        },
        {
            title: '9. Intellectual property',
            body: <p>The Movida name, logo, design and software belong to us. Please don&rsquo;t copy them or systematically extract Movida&rsquo;s event data.</p>,
        },
        {
            title: '10. Availability and liability',
            body: (
                <p>
                    Movida is provided free of charge and &ldquo;as is&rdquo;. We may change or discontinue features. To the extent allowed by law, we are not liable
                    for event changes or cancellations, for content posted by others, or for indirect losses. Nothing in these Terms limits rights you have as a
                    consumer that cannot be limited by law.
                </p>
            ),
        },
        {
            title: '11. Ending your use',
            body: <p>You can delete your account at any time in Settings. We may suspend or close accounts that seriously or repeatedly break these Terms.</p>,
        },
        {
            title: '12. Changes',
            body: <p>We will tell you in the app or by email before significant changes take effect. If you keep using Movida afterwards, the new Terms apply.</p>,
        },
        {
            title: '13. Applicable law and contact',
            body: (
                <p>
                    If you are a consumer, the mandatory consumer-protection rules of your country of residence apply. Questions: {mail}.
                </p>
            ),
        },
    ],
};

const fr: LegalVersion = {
    title: 'Conditions d’utilisation & règles de la communauté',
    updated: 'Dernière mise à jour : octobre 2026',
    sections: [
        {
            title: '1. À propos de Movida',
            body: (
                <p>
                    Movida est une plateforme communautaire gratuite pour découvrir des événements de danse sociale, les organiser entre amis et garder une
                    trace des endroits où vous avez dansé. Elle est éditée par Ouissam Gouni (voir les {legalLink('mentions légales')}). En utilisant
                    Movida, vous acceptez ces conditions et prenez connaissance de notre {privacyLink('politique de confidentialité')}.
                </p>
            ),
        },
        {
            title: '2. Qui peut utiliser Movida',
            body: (
                <Bullets items={[
                    'Vous devez avoir au moins 16 ans.',
                    'Un compte par personne. Protégez l’accès à votre e-mail ou compte Google : vous êtes responsable de l’activité de votre compte.',
                ]} />
            ),
        },
        {
            title: '3. Informations sur les événements',
            body: (
                <p>
                    Les événements proviennent de sources publiques (par exemple les agendas publics des organisateurs) et des propositions des membres.
                    Les informations peuvent être incomplètes ou changer rapidement : vérifiez toujours auprès de l&rsquo;organisateur avant de vous déplacer ou
                    d&rsquo;acheter un billet. Movida ne vend pas de billets et n&rsquo;est partie à aucun achat. Les codes promo sont partagés par des membres ou
                    organisateurs, sans garantie.
                </p>
            ),
        },
        {
            title: '4. Vos contenus',
            body: (
                <p>
                    Vous restez propriétaire de ce que vous publiez (avis, messages, photos, propositions d&rsquo;événements, codes promo, profil). Vous nous
                    accordez une licence gratuite, non exclusive et mondiale pour les héberger, les afficher et les adapter techniquement (par exemple
                    redimensionner les images) dans Movida tant qu&rsquo;ils sont en ligne. Vous garantissez en avoir le droit, y compris le consentement des
                    personnes visibles sur vos photos.
                </p>
            ),
        },
        {
            title: '5. Règles de la communauté',
            body: (
                <>
                    <p>Movida, c&rsquo;est danser ensemble. Merci de :</p>
                    <Bullets items={[
                        'Rester respectueux : pas de harcèlement, de discours haineux, de discrimination, de menaces ni de contenu sexuel sans consentement — et jamais impliquant des mineurs.',
                        'Respecter la vie privée : ne partagez pas les données personnelles d’autrui et ne publiez pas de photos de personnes qui n’ont pas accepté.',
                        'Rester honnête : ne notez que des événements que vous connaissez, pas de faux avis, et ne notez pas votre propre événement ni ceux de concurrents pour fausser les notes.',
                        'Pas de spam, de publicité hors sujet, d’usurpation d’identité ni d’événements trompeurs.',
                        'Ne publier que des contenus dont vous avez les droits (photos, flyers, musique, logos).',
                        'Ne pas aspirer, surcharger ou tenter de pirater Movida.',
                    ]} />
                </>
            ),
        },
        {
            title: '6. Signalements et modération',
            body: (
                <>
                    <p>
                        Toute personne, avec ou sans compte, peut signaler un contenu qu&rsquo;elle estime illicite ou contraire à ces règles, via les liens
                        « Report » de l&rsquo;application ou par e-mail à {mail}. Indiquez le lien, la raison, votre nom et une déclaration de bonne foi.
                        Les organisateurs peuvent utiliser « Report or request removal » sur la page d&rsquo;un événement pour corriger ou retirer leur événement ou leurs images.
                    </p>
                    <p>
                        Nous traitons les signalements rapidement. Nous pouvons retirer des contenus, limiter des fonctionnalités ou suspendre des comptes contraires
                        à la loi ou à ces règles. Les commentaires d&rsquo;avis sont vérifiés avant publication. Lorsque nous retirons votre contenu ou restreignons
                        votre compte, nous vous en expliquons les raisons par e-mail et vous pouvez répondre pour contester la décision.
                    </p>
                </>
            ),
        },
        {
            title: '7. Fonctionnement des avis',
            body: (
                <p>
                    Les avis peuvent être rédigés par les membres connectés une fois l&rsquo;événement terminé. Les commentaires écrits sont modérés avant
                    publication ; la présence à l&rsquo;événement n&rsquo;est pas vérifiée. Nous n&rsquo;acceptons aucune rémunération pour des avis et ne supprimons
                    pas un avis au seul motif qu&rsquo;il est négatif.
                </p>
            ),
        },
        {
            title: '8. Organisateurs',
            body: (
                <p>
                    Les badges organisateur et les revendications d&rsquo;événements sont accordés après vérification manuelle. Les organisateurs sont responsables
                    de l&rsquo;exactitude des informations fournies ; leurs modifications d&rsquo;événements publics peuvent être relues avant publication.
                </p>
            ),
        },
        {
            title: '9. Propriété intellectuelle',
            body: <p>Le nom, le logo, le design et le logiciel Movida nous appartiennent. Merci de ne pas les copier ni d&rsquo;extraire systématiquement les données d&rsquo;événements de Movida.</p>,
        },
        {
            title: '10. Disponibilité et responsabilité',
            body: (
                <p>
                    Movida est fourni gratuitement et « en l&rsquo;état ». Nous pouvons modifier ou arrêter des fonctionnalités. Dans les limites permises par la loi,
                    nous ne sommes pas responsables des changements ou annulations d&rsquo;événements, des contenus publiés par d&rsquo;autres, ni des dommages indirects.
                    Rien dans ces conditions ne limite les droits que la loi vous garantit en tant que consommateur.
                </p>
            ),
        },
        {
            title: '11. Fin de l’utilisation',
            body: <p>Vous pouvez supprimer votre compte à tout moment dans les Réglages. Nous pouvons suspendre ou fermer les comptes qui enfreignent gravement ou de manière répétée ces conditions.</p>,
        },
        {
            title: '12. Modifications',
            body: <p>Nous vous informerons dans l&rsquo;application ou par e-mail avant toute modification importante. Si vous continuez à utiliser Movida ensuite, les nouvelles conditions s&rsquo;appliquent.</p>,
        },
        {
            title: '13. Droit applicable et contact',
            body: (
                <p>
                    Si vous êtes consommateur, les règles impératives de protection des consommateurs de votre pays de résidence s&rsquo;appliquent. Questions : {mail}.
                </p>
            ),
        },
    ],
};

export default function Terms() {
    return <LegalDocument en={en} fr={fr} />;
}
