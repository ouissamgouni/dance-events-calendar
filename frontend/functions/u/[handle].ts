/** Link-preview card for public profiles (crawlers only); only the handle is used. */
import { fallbackImage, isBot, publicBaseFor, renderCard, type OgEnv } from '../_lib/og';

export const onRequestGet: PagesFunction<OgEnv> = async ({ request, env, params, next }) => {
    const handle = params.handle;
    if (!isBot(request.headers.get('user-agent')) || typeof handle !== 'string' || !handle) {
        return next();
    }
    const publicBase = publicBaseFor(request, env);
    return renderCard({
        title: `@${handle} on Movida`,
        description: `Follow @${handle} on Movida and find your next salsa, bachata, kizomba or zouk event.`,
        url: `${publicBase}/u/${encodeURIComponent(handle)}`,
        image: fallbackImage(publicBase, env),
    });
};
