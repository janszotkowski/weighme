import { parseSpec, type AnalysisResponse, type AnalysisResult, type PackageRef, type PackagesResponse } from '@weighme/core';
import { ALLOW_INDEXING, canonicalUrl } from '@config/site';
import { fixedWindowLimiter, ttlCache } from '@lib/rateLimit';
import { packageBadge, type Badge } from './badge';
import { API_CATALOG_TYPE, aiCatalog, apiCatalog } from './discovery';
import { llmsTxt } from './llms';
import { markdownTokens, notMeasuredMarkdown, packageMarkdown, packagePathSpec, wantsMarkdown } from './markdown';
import { robotsTxt } from './robots';
import { securityTxt } from './securityTxt';
import { ShareImageBusy, createShareImages } from './shareImages';
import { STATIC_PAGES, packageSitemap, packageSitemapCount, packageSitemapPage, pagesSitemap, sitemapIndex } from './sitemap';

/** What the documents are made from: the API and the drawing of images in production; tests pass their own. */
export type DocumentDeps = {
    /** A package only if it has been measured, so that no document ever causes a download. */
    knownAnalysis: (spec: string) => Promise<AnalysisResponse | undefined>;
    measuredPackages: () => Promise<PackagesResponse['packages']>;
    drawDefaultImage: () => Promise<Uint8Array>;
    drawPackageImage: (ref: PackageRef, result: AnalysisResult) => Promise<Uint8Array>;
    /** Whom the request being answered is for, when that is known. */
    visitor: () => string | undefined;
};

/** Documents for crawlers change slowly: a CDN may keep them for an hour. */
const DOCUMENT_CACHE = 'public, max-age=3600, s-maxage=3600';

/** Markdown at a page's own address: kept by the agent that asked, never by a shared cache, which would serve it to browsers as the page. */
const NEGOTIATED_CACHE = 'private, max-age=300';

const text = (body: string, contentType: string, cache = DOCUMENT_CACHE, status = 200, extra: Record<string, string> = {}): Response =>
    new Response(body, { status, headers: { 'content-type': contentType, 'cache-control': cache, ...extra } });

const notFound = (): Response => text('Not found', 'text/plain; charset=utf-8', 'public, max-age=300', 404);

/** A file past the last one is not an empty sitemap: it does not exist, and will not for a while. */
const NO_SITEMAP_CACHE = 'public, max-age=300';

const png = (bytes: Uint8Array<ArrayBuffer>, cache: string): Response => new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': cache } });

const siteCard = (cache: string): Response => new Response(null, { status: 302, headers: { location: canonicalUrl('/og/default.png'), 'cache-control': cache } });

const OG_PACKAGE = /^\/og\/package\/(.+)\.png$/;
const BADGE = /^\/badge\/(.+)\.svg$/;

/** A path segment as typed; an encoding that does not decode is no package name, which `parseSpec` then says. */
const decoded = (segment: string): string => {
    try {
        return decodeURIComponent(segment);
    } catch {
        return '';
    }
};

/**
 * What the server answers itself, before the router: the documents at a fixed address, the sitemap's files, share
 * images, badges and packages as Markdown. What it keeps between requests (drawn images, the list of measured packages,
 * badges, each visitor's count of share images) lives in the one made here. Answers `undefined` for anything else (a page).
 */
export const createDocuments = (deps: DocumentDeps) => {
    /** Share images are the costliest thing here, and a package's is a different one for every version: one visitor gets a few a minute, then the site's card. */
    const ogLimiter = fixedWindowLimiter({ limit: 30, windowMs: 60_000 });
    const shareImages = createShareImages({ cacheMax: 300, drawingMax: 2, waitingMax: 20 });

    /**
     * The measured packages the sitemap lists, read from the API at most every ten minutes: the index and every file are
     * cut from one list, so a crawler walking them costs one request, and a file past the last one is refused without any.
     */
    const measured = ttlCache<PackagesResponse['packages']>({ ttlMs: 10 * 60_000, max: 1 });
    const measuredPackages = (): Promise<PackagesResponse['packages']> => measured.get('packages', deps.measuredPackages);

    /** A badge is fetched each time a README is read, mostly through one proxy: what it says is asked of the API at most every few minutes. */
    const badges = ttlCache<Badge>({ ttlMs: 5 * 60_000, max: 1000 });

    /** The documents at a fixed address. None of them can cause a package to be downloaded. */
    const DOCUMENTS: Readonly<Record<string, () => Response | Promise<Response>>> = {
        '/robots.txt': () => text(robotsTxt(ALLOW_INDEXING), 'text/plain; charset=utf-8'),
        '/llms.txt': () => text(llmsTxt(), 'text/plain; charset=utf-8'),
        '/.well-known/security.txt': () => text(securityTxt(new Date()), 'text/plain; charset=utf-8', 'public, max-age=86400'),
        '/.well-known/api-catalog': () => text(apiCatalog(), API_CATALOG_TYPE),
        // Read by agents and registries from other origins, so any page may fetch it.
        '/.well-known/ai-catalog.json': () => text(aiCatalog(), 'application/json; charset=utf-8', DOCUMENT_CACHE, 200, { 'access-control-allow-origin': '*' }),
        '/sitemap.xml': async () => text(sitemapIndex((await measuredPackages()).length), 'application/xml; charset=utf-8'),
        '/sitemaps/pages.xml': () => text(pagesSitemap(), 'application/xml; charset=utf-8'),
        '/og/default.png': async () => png(await shareImages.get('default', deps.drawDefaultImage), 'public, max-age=86400, s-maxage=604800'),
    };

    /** One file of the package sitemap, by its number in the address. */
    const packageSitemapResponse = async (page: number): Promise<Response> => {
        const packages = await measuredPackages();
        if (page > packageSitemapCount(packages.length)) return text('Not found', 'text/plain; charset=utf-8', NO_SITEMAP_CACHE, 404);
        return text(packageSitemap(packages, page), 'application/xml; charset=utf-8');
    };

    /** A package's share image, from what has been measured. A broken preview must never break a share: anything else gets the site's card. */
    const packageOgImage = async (spec: string): Promise<Response> => {
        if (parseSpec(spec) === undefined) return notFound();
        if (!ogLimiter.take(deps.visitor() ?? 'unknown')) return siteCard('public, max-age=60');
        try {
            const analysis = await deps.knownAnalysis(spec);
            if (analysis?.status !== 'done') return siteCard('public, max-age=300');
            const key = `${analysis.package.name}@${analysis.package.version}:${analysis.analyzerVersion}`;
            return png(await shareImages.get(key, () => deps.drawPackageImage(analysis.package, analysis.result)), 'public, max-age=86400, s-maxage=86400');
        } catch (error) {
            if (!(error instanceof ShareImageBusy)) console.error('share image failed', error);
            return siteCard('public, max-age=300');
        }
    };

    /** A package's README badge, from what has been measured, so showing one never causes a download. A broken API still draws a badge, not a broken image. */
    const packageBadgeResponse = async (spec: string): Promise<Response> => {
        if (parseSpec(spec) === undefined) return notFound();
        const badge = await badges
            .get(spec, async () => packageBadge(await deps.knownAnalysis(spec)))
            .catch((error: unknown) => {
                console.error('badge failed', error);
                return packageBadge(undefined, true);
            });
        return text(badge.svg, 'image/svg+xml; charset=utf-8', badge.cache);
    };

    /** A package as Markdown: its `.md` twin, or its page asked for with `Accept: text/markdown`. Only what has been measured. */
    const packageMarkdownResponse = async (spec: string, twin: boolean): Promise<Response> => {
        const markdown = (body: string, status: number, extra: Record<string, string> = {}) =>
            text(body, 'text/markdown; charset=utf-8', status !== 200 ? 'no-store' : twin ? 'public, max-age=300, s-maxage=900' : NEGOTIATED_CACHE, status, {
                'x-markdown-tokens': String(markdownTokens(body)),
                vary: 'Accept',
                ...extra,
            });
        const analysis = await deps.knownAnalysis(spec);
        if (analysis === undefined) return markdown(notMeasuredMarkdown(spec), 404);
        return markdown(packageMarkdown(analysis), 200, { link: `<${canonicalUrl(`/package/${analysis.package.name}`)}>; rel="canonical"` });
    };

    return (request: Request, pathname: string): Promise<Response> | Response | undefined => {
        const document = DOCUMENTS[pathname];
        if (document !== undefined) return document();
        const sitemapPage = packageSitemapPage(pathname);
        if (sitemapPage !== undefined) return packageSitemapResponse(sitemapPage);
        const og = OG_PACKAGE.exec(pathname)?.[1];
        if (og !== undefined) return packageOgImage(decoded(og));
        const badge = BADGE.exec(pathname)?.[1];
        if (badge !== undefined) return packageBadgeResponse(decoded(badge));
        const accept = request.headers.get('accept');
        const pkg = packagePathSpec(pathname);
        if (pkg !== undefined && (pkg.twin || wantsMarkdown(accept))) return packageMarkdownResponse(pkg.spec, pkg.twin);
        // The site's own pages as Markdown: what `llms.txt` says of the whole site, which is what they are about.
        if (STATIC_PAGES.includes(pathname) && wantsMarkdown(accept)) {
            const body = llmsTxt();
            return text(body, 'text/markdown; charset=utf-8', NEGOTIATED_CACHE, 200, {
                'x-markdown-tokens': String(markdownTokens(body)),
                vary: 'Accept',
                link: `<${canonicalUrl(pathname)}>; rel="canonical"`,
            });
        }
        return undefined;
    };
};
