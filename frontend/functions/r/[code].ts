/** Link-preview card for invite links (crawlers only); humans get the SPA. */
import { fallbackImage, isBot, publicBaseFor, renderCard, type OgEnv } from '../_lib/og';

export const onRequestGet: PagesFunction<OgEnv> = async ({ request, env, params, next }) => {
    const code = params.code;
    if (!isBot(request.headers.get('user-agent')) || typeof code !== 'string' || !code) {
        return next();
    }
    const publicBase = publicBaseFor(request, env);
    return renderCard({
        title: "You're invited to Movida 💃🕺",
        description: "Salsa, bachata, kizomba & zouk socials and festivals in one place. Join your friends and see who's going.",
        url: `${publicBase}/r/${encodeURIComponent(code)}`,
        image: fallbackImage(publicBase, env),
    });
};
