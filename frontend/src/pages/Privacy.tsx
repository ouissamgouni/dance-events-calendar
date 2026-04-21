import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { useConsent } from '../context/ConsentContext';

export default function Privacy() {
    const { showPreferences } = useConsent();

    return (
        <>
            <Helmet>
                <title>Politique de confidentialité – Movida</title>
            </Helmet>
            <div className="max-w-3xl mx-auto px-4 py-8 text-slate-800">
                <Link to="/" className="text-sm text-blue-600 hover:underline mb-4 inline-block">
                    ← Retour
                </Link>

                <h1 className="text-2xl font-bold mb-6">Politique de confidentialité</h1>
                <p className="text-sm text-slate-500 mb-8">Dernière mise à jour : juillet 2025</p>

                <section className="mb-8">
                    <h2 className="text-lg font-semibold mb-3">1. Qui sommes-nous ?</h2>
                    <p className="mb-2">
                        Movida est un calendrier communautaire d'événements de danse (salsa, bachata, kizomba…).
                        Le site est exploité à titre non-commercial et ne collecte aucune donnée à des fins publicitaires.
                    </p>
                </section>

                <section className="mb-8">
                    <h2 className="text-lg font-semibold mb-3">2. Quelles données collectons-nous ?</h2>

                    <h3 className="font-medium mt-4 mb-2">Données strictement nécessaires (pas de consentement requis)</h3>
                    <ul className="list-disc ml-6 mb-4 space-y-1">
                        <li>
                            <strong>Événements favoris</strong> : stockés uniquement dans le navigateur
                            (localStorage). Ces données ne quittent jamais votre appareil.
                        </li>
                        <li>
                            <strong>Cookie de session</strong> : si vous vous connectez en tant qu'administrateur,
                            un cookie <code>session_token</code> est créé (durée : 7 jours, httpOnly, sameSite=lax).
                        </li>
                        <li>
                            <strong>Cookie de consentement</strong> : le cookie <code>cc_cookie</code> enregistre
                            vos préférences de cookies (durée : 182 jours).
                        </li>
                    </ul>

                    <h3 className="font-medium mt-4 mb-2">Données d'analyse (consentement requis)</h3>
                    <p className="mb-2">
                        Si vous acceptez les cookies d'analyse, nous enregistrons de manière anonyme :
                    </p>
                    <ul className="list-disc ml-6 mb-4 space-y-1">
                        <li>Les événements consultés et leur source (calendrier, liste, carte)</li>
                        <li>Les clics sur les liens externes des événements</li>
                        <li>Les exports de calendrier (format et nombre d'événements)</li>
                    </ul>
                    <p className="mb-2">
                        Ces données ne contiennent <strong>aucune information personnelle identifiable</strong>.
                        Elles nous aident uniquement à comprendre quels événements intéressent la communauté.
                    </p>

                    <h3 className="font-medium mt-4 mb-2">Données de personnalisation (consentement requis)</h3>
                    <p className="mb-2">
                        Si vous acceptez les cookies de personnalisation, un identifiant anonyme
                        (<code>movida_device_id</code>) est généré et stocké dans votre navigateur.
                        Cet identifiant permet de synchroniser vos favoris côté serveur.
                        Il ne contient aucune information personnelle.
                    </p>
                </section>

                <section className="mb-8">
                    <h2 className="text-lg font-semibold mb-3">3. Pas de services tiers</h2>
                    <p>
                        Movida n'utilise <strong>aucun service d'analyse tiers</strong> (pas de Google Analytics,
                        pas de Meta Pixel, pas de tracker publicitaire). Toutes les données d'analyse sont
                        stockées sur notre propre serveur.
                    </p>
                </section>

                <section className="mb-8">
                    <h2 className="text-lg font-semibold mb-3">4. Durée de conservation</h2>
                    <ul className="list-disc ml-6 space-y-1">
                        <li>Les données d'analyse sont conservées pendant 12 mois maximum.</li>
                        <li>Les favoris locaux sont conservés tant que vous ne les supprimez pas.</li>
                        <li>Le cookie de session expire après 7 jours.</li>
                    </ul>
                </section>

                <section className="mb-8">
                    <h2 className="text-lg font-semibold mb-3">5. Vos droits (RGPD)</h2>
                    <p className="mb-2">Conformément au RGPD, vous avez le droit de :</p>
                    <ul className="list-disc ml-6 mb-4 space-y-1">
                        <li><strong>Retirer votre consentement</strong> à tout moment via le bouton ci-dessous.</li>
                        <li>
                            <strong>Supprimer vos données</strong> : si vous avez un identifiant d'appareil,
                            toutes les données associées peuvent être supprimées sur demande.
                        </li>
                        <li><strong>Accéder à vos données</strong> : contactez-nous pour obtenir une copie.</li>
                    </ul>
                    <button
                        onClick={showPreferences}
                        className="bg-slate-800 text-white px-4 py-2 rounded text-sm hover:bg-slate-700 transition"
                    >
                        Modifier mes préférences de cookies
                    </button>
                </section>

                <section className="mb-8">
                    <h2 className="text-lg font-semibold mb-3">6. Contact</h2>
                    <p>
                        Pour toute question relative à vos données personnelles, vous pouvez nous contacter
                        via la page Instagram de Movida.
                    </p>
                </section>

                <hr className="my-8 border-slate-200" />

                {/* English version */}
                <h1 className="text-2xl font-bold mb-6">Privacy Policy</h1>
                <p className="text-sm text-slate-500 mb-8">Last updated: July 2025</p>

                <section className="mb-8">
                    <h2 className="text-lg font-semibold mb-3">1. Who are we?</h2>
                    <p className="mb-2">
                        Movida is a community calendar for dance events (salsa, bachata, kizomba…).
                        The site is operated on a non-commercial basis and does not collect data for advertising purposes.
                    </p>
                </section>

                <section className="mb-8">
                    <h2 className="text-lg font-semibold mb-3">2. What data do we collect?</h2>

                    <h3 className="font-medium mt-4 mb-2">Strictly necessary data (no consent required)</h3>
                    <ul className="list-disc ml-6 mb-4 space-y-1">
                        <li>
                            <strong>Bookmarked events</strong>: stored only in your browser (localStorage).
                            This data never leaves your device.
                        </li>
                        <li>
                            <strong>Session cookie</strong>: if you log in as an admin, a <code>session_token</code> cookie
                            is created (7-day duration, httpOnly, sameSite=lax).
                        </li>
                        <li>
                            <strong>Consent cookie</strong>: the <code>cc_cookie</code> stores your cookie
                            preferences (182 days).
                        </li>
                    </ul>

                    <h3 className="font-medium mt-4 mb-2">Analytics data (consent required)</h3>
                    <p className="mb-2">
                        If you accept analytics cookies, we anonymously record:
                    </p>
                    <ul className="list-disc ml-6 mb-4 space-y-1">
                        <li>Events viewed and their source (calendar, list, map)</li>
                        <li>Clicks on external event links</li>
                        <li>Calendar exports (format and event count)</li>
                    </ul>
                    <p className="mb-2">
                        This data contains <strong>no personally identifiable information</strong>.
                        It only helps us understand which events interest the community.
                    </p>

                    <h3 className="font-medium mt-4 mb-2">Personalization data (consent required)</h3>
                    <p className="mb-2">
                        If you accept personalization cookies, an anonymous identifier
                        (<code>movida_device_id</code>) is generated and stored in your browser.
                        This identifier allows server-side bookmark syncing.
                        It contains no personal information.
                    </p>
                </section>

                <section className="mb-8">
                    <h2 className="text-lg font-semibold mb-3">3. No third-party services</h2>
                    <p>
                        Movida uses <strong>no third-party analytics</strong> (no Google Analytics,
                        no Meta Pixel, no ad trackers). All analytics data is stored on our own server.
                    </p>
                </section>

                <section className="mb-8">
                    <h2 className="text-lg font-semibold mb-3">4. Data retention</h2>
                    <ul className="list-disc ml-6 space-y-1">
                        <li>Analytics data is retained for a maximum of 12 months.</li>
                        <li>Local bookmarks are kept until you delete them.</li>
                        <li>The session cookie expires after 7 days.</li>
                    </ul>
                </section>

                <section className="mb-8">
                    <h2 className="text-lg font-semibold mb-3">5. Your rights (GDPR)</h2>
                    <p className="mb-2">Under the GDPR, you have the right to:</p>
                    <ul className="list-disc ml-6 mb-4 space-y-1">
                        <li><strong>Withdraw your consent</strong> at any time using the button below.</li>
                        <li>
                            <strong>Delete your data</strong>: if you have a device identifier,
                            all associated data can be deleted on request.
                        </li>
                        <li><strong>Access your data</strong>: contact us for a copy.</li>
                    </ul>
                    <button
                        onClick={showPreferences}
                        className="bg-slate-800 text-white px-4 py-2 rounded text-sm hover:bg-slate-700 transition"
                    >
                        Manage cookie preferences
                    </button>
                </section>

                <section className="mb-8">
                    <h2 className="text-lg font-semibold mb-3">6. Contact</h2>
                    <p>
                        For any questions about your personal data, you can contact us via the Movida Instagram page.
                    </p>
                </section>
            </div>
        </>
    );
}
