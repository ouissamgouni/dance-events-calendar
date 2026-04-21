import type { CookieConsentConfig } from 'vanilla-cookieconsent';

export const cookieConsentConfig: CookieConsentConfig = {
    categories: {
        necessary: {
            enabled: true,
            readOnly: true,
        },
        analytics: {
            enabled: false,
            readOnly: false,
        },
        personalization: {
            enabled: false,
            readOnly: false,
        },
    },

    language: {
        default: 'fr',
        autoDetect: 'browser',
        translations: {
            fr: {
                consentModal: {
                    title: 'Nous utilisons des cookies',
                    description:
                        'Ce site utilise des cookies pour améliorer votre expérience. Les cookies nécessaires sont toujours actifs. Vous pouvez choisir d\'activer les cookies d\'analyse et de personnalisation. <a href="/privacy" class="cc-link">Politique de confidentialité</a>',
                    acceptAllBtn: 'Tout accepter',
                    acceptNecessaryBtn: 'Refuser tout',
                    showPreferencesBtn: 'Personnaliser',
                },
                preferencesModal: {
                    title: 'Préférences de cookies',
                    acceptAllBtn: 'Tout accepter',
                    acceptNecessaryBtn: 'Refuser tout',
                    savePreferencesBtn: 'Enregistrer',
                    closeIconLabel: 'Fermer',
                    sections: [
                        {
                            title: 'Utilisation des cookies',
                            description:
                                'Nous utilisons des cookies pour améliorer votre expérience sur Movida. Vous pouvez choisir les catégories que vous souhaitez autoriser.',
                        },
                        {
                            title: 'Cookies strictement nécessaires',
                            description:
                                'Ces cookies sont essentiels au fonctionnement du site (sauvegarde locale de vos événements favoris, session d\'authentification).',
                            linkedCategory: 'necessary',
                        },
                        {
                            title: 'Cookies d\'analyse',
                            description:
                                'Ces cookies nous permettent de comprendre comment vous utilisez le site (vues d\'événements, clics sur les liens, exports). Toutes les données sont anonymes.',
                            linkedCategory: 'analytics',
                        },
                        {
                            title: 'Cookies de personnalisation',
                            description:
                                'Ces cookies permettent de synchroniser vos événements favoris entre vos appareils grâce à un identifiant anonyme.',
                            linkedCategory: 'personalization',
                        },
                    ],
                },
            },
            en: {
                consentModal: {
                    title: 'We use cookies',
                    description:
                        'This site uses cookies to improve your experience. Necessary cookies are always active. You can choose to enable analytics and personalization cookies. <a href="/privacy" class="cc-link">Privacy Policy</a>',
                    acceptAllBtn: 'Accept all',
                    acceptNecessaryBtn: 'Reject all',
                    showPreferencesBtn: 'Customize',
                },
                preferencesModal: {
                    title: 'Cookie Preferences',
                    acceptAllBtn: 'Accept all',
                    acceptNecessaryBtn: 'Reject all',
                    savePreferencesBtn: 'Save preferences',
                    closeIconLabel: 'Close',
                    sections: [
                        {
                            title: 'Cookie usage',
                            description:
                                'We use cookies to improve your experience on Movida. You can choose which categories you want to allow.',
                        },
                        {
                            title: 'Strictly necessary cookies',
                            description:
                                'These cookies are essential for the site to function (local bookmark storage, authentication session).',
                            linkedCategory: 'necessary',
                        },
                        {
                            title: 'Analytics cookies',
                            description:
                                'These cookies help us understand how you use the site (event views, link clicks, exports). All data is anonymous.',
                            linkedCategory: 'analytics',
                        },
                        {
                            title: 'Personalization cookies',
                            description:
                                'These cookies allow syncing your bookmarked events across devices using an anonymous identifier.',
                            linkedCategory: 'personalization',
                        },
                    ],
                },
            },
        },
    },
};
