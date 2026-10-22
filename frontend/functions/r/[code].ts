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
        description: "Discover dance events, see who's going and make plans together. Get the details, community feedback and updates in one place.",
        url: `${publicBase}/r/${encodeURIComponent(code)}`,
        image: fallbackImage(publicBase, env),
    });
};
