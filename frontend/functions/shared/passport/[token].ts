/** Link-preview card for shared Dance Passport links (crawlers only). */
import { fallbackImage, fetchJson, isBot, publicBaseFor, renderCard, type OgEnv } from '../../_lib/og';

interface SharedPassport {
    display_name: string | null;
    stats: { total_events_attended: number; cities_visited: number; countries_visited: number };
}

function count(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

export const onRequestGet: PagesFunction<OgEnv> = async ({ request, env, params, next }) => {
    const token = params.token;
    if (!isBot(request.headers.get('user-agent')) || typeof token !== 'string' || !token) {
        return next();
    }
    const publicBase = publicBaseFor(request, env);
    // Sign-in-only shares return 401 here, so they fall back to the generic card.
    const passport = env.API_BASE
        ? await fetchJson<SharedPassport>(`${env.API_BASE}/api/passport/shared/${encodeURIComponent(token)}`)
        : null;

    const name = passport?.display_name?.trim();
    const stats = passport?.stats;
    return renderCard({
        title: name ? `${name}'s Dance Passport · Movida` : 'Dance Passport · Movida',
        description: stats
            ? `${count(stats.total_events_attended, 'event', 'events')} · ${count(stats.cities_visited, 'city', 'cities')} · ${count(stats.countries_visited, 'country', 'countries')} danced. Where's your next one?`
            : 'Every social, congress and festival, stamped. Start your own dance passport on Movida.',
        url: `${publicBase}/shared/passport/${encodeURIComponent(token)}`,
        image: fallbackImage(publicBase, env),
    });
};
