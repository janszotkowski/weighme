import {
    MAX_LISTED_PACKAGES,
    MAX_SEARCH_LENGTH,
    MIN_SEARCH_LENGTH,
    analysisFailureSchema,
    analysisResultSchema,
    exportDetailsSchema,
    TREND_RANGES,
    isComplete,
    openApiDocument,
    readPackageName,
    readPackageRef,
    readPackageSpec,
    type PackageRead,
} from '@weighme/core';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AnalysisAnswer, Analyses } from '@modules/analyses/application/analyses.ts';
import type { DownloadsReader, PackageSearcher } from '@modules/analyses/application/ports.ts';
import type { AnalysisStore } from '@modules/analyses/infrastructure/store.ts';
import { AppError } from '@platform/errors.ts';
import type { AppEnv } from '@platform/http/app.ts';
import { sameSecret } from '@platform/secrets.ts';

/**
 * Everything public is the same for every caller, so a CDN in front may keep it (`s-maxage`) and serve it a while longer
 * while it asks again (`stale-while-revalidate`); the browser's own copy (`max-age`) is kept shorter. What is still being
 * measured is `no-store`: the page polls it. A finished result of an exact version does not change until the analyzer does.
 */
const SHORT_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';
const DETAIL_CACHE = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=3600';
const EXACT_CACHE = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400';

const REPOSITORY = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

/** What the public routes answer with: the use cases, and the two readers whose answers are passed on as they are. */
export type AnalysisDeps = {
    analyses: Analyses;
    search: PackageSearcher;
    readDownloads: DownloadsReader;
};

/** What a tag points to changes with the next release; the result of an exact version does not. What is still being measured is asked for again. */
const cacheOf = (answer: AnalysisAnswer): string => (isComplete(answer.analysis) ? (answer.exact ? EXACT_CACHE : SHORT_CACHE) : 'no-store');

/** What was read of the `package` parameter (`readPackageSpec` and its kin), or the reason it is none as the caller's mistake. */
const packageOf = <T>(read: PackageRead<T>): T => {
    if (!read.ok) throw new AppError('VALIDATION_FAILED', read.reason);
    return read.value;
};

/** The body as JSON. A body that is not JSON is the caller's mistake, not the server's. */
const readJson = async (c: Context<AppEnv>): Promise<unknown> => {
    try {
        return await c.req.json();
    } catch {
        throw new AppError('VALIDATION_FAILED', 'The body is not valid JSON');
    }
};

/** The public API: what a package costs. */
export const analysisRoutes = (deps: AnalysisDeps, options: { rateLimitPerMinute: number }): Hono<AppEnv> => {
    const { analyses, search, readDownloads } = deps;
    const routes = new Hono<AppEnv>();

    // The contract for generated clients; it changes only with a deployment.
    const openApi = openApiDocument({ rateLimitPerMinute: options.rateLimitPerMinute });
    routes.get('/openapi.json', (c) => {
        c.header('cache-control', 'public, max-age=3600, s-maxage=3600');
        return c.json(openApi);
    });

    routes.get('/history', async (c) => {
        c.header('cache-control', 'no-store');
        return c.json(await analyses.history(packageOf(readPackageName(c.req.query('package') ?? ''))));
    });

    // Measuring downloads every version, so it is only ever asked for, never done because a page was opened.
    routes.post('/history', async (c) => {
        const history = await analyses.measureHistory(packageOf(readPackageName(c.req.query('package') ?? '')));
        c.header('cache-control', 'no-store');
        return c.json(history);
    });

    routes.get('/analyses', async (c) => {
        const spec = packageOf(readPackageSpec(c.req.query('package') ?? ''));
        // Documents for crawlers ask with `known=1`: they read what has been measured, and never cause a download.
        const answer = c.req.query('known') === '1' ? await analyses.known(spec) : await analyses.lookUp(spec, c.get('queueShare'));
        c.header('cache-control', cacheOf(answer));
        return c.json(answer.analysis);
    });

    routes.get('/packages', (c) => {
        c.header('cache-control', DETAIL_CACHE);
        return c.json({ packages: analyses.measuredPackages(MAX_LISTED_PACKAGES) });
    });

    routes.get('/downloads', async (c) => {
        const name = packageOf(readPackageName(c.req.query('package') ?? ''));
        const range = TREND_RANGES.find((candidate) => candidate === c.req.query('range'));
        if (range === undefined) throw new AppError('VALIDATION_FAILED', `range must be one of ${TREND_RANGES.join(', ')}`);
        c.header('cache-control', DETAIL_CACHE);
        return c.json({ name, days: await readDownloads(name, range) });
    });

    routes.get('/stars', async (c) => {
        const repository = c.req.query('repository') ?? '';
        if (!REPOSITORY.test(repository) || repository.split('/').some((part) => part.startsWith('.'))) throw new AppError('VALIDATION_FAILED', 'repository must be owner/name');
        c.header('cache-control', DETAIL_CACHE);
        return c.json({ stars: await analyses.stars(repository) });
    });

    routes.get('/metadata', async (c) => {
        const ref = packageOf(readPackageRef(c.req.query('package') ?? ''));
        c.header('cache-control', DETAIL_CACHE);
        return c.json(await analyses.metadata(ref));
    });

    routes.get('/search', async (c) => {
        const query = (c.req.query('q') ?? '').trim();
        if (query.length < MIN_SEARCH_LENGTH || query.length > MAX_SEARCH_LENGTH) throw new AppError('VALIDATION_FAILED', `q must be ${MIN_SEARCH_LENGTH} to ${MAX_SEARCH_LENGTH} characters`);
        c.header('cache-control', SHORT_CACHE);
        return c.json({ packages: await search(query) });
    });

    return routes;
};

// Fifteen digits at most: every one of them is a whole number JavaScript can hold exactly.
const JOB_ID = /^[1-9]\d{0,14}$/;

const jobId = (value: string): number => {
    if (!JOB_ID.test(value)) throw new AppError('VALIDATION_FAILED', 'id must be a positive whole number');
    return Number(value);
};

/**
 * What only the worker calls: take a job, hand in its result. Never reachable from a browser (no CORS) or without the token.
 * The worker reaches the API inside the machine, never through the proxy in front of it: a request carrying the header
 * that proxy writes (`proxyHeader`, the configured `CLIENT_IP_HEADER`) came from the internet, and finds nothing here.
 */
export const workerRoutes = (store: AnalysisStore, workerToken: string, proxyHeader?: string): Hono<AppEnv> => {
    const routes = new Hono<AppEnv>();

    routes.use(async (c, next) => {
        if (proxyHeader !== undefined && c.req.header(proxyHeader) !== undefined) throw new AppError('NOT_FOUND', 'There is nothing at this address');
        const token = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1];
        if (token === undefined || !sameSecret(token, workerToken)) throw new AppError('UNAUTHORIZED', 'A valid worker token is required');
        await next();
    });
    // The largest body is a package's list of exports, with a name and two sizes for each.
    routes.use(bodyLimit({ maxSize: 512 * 1024 }));

    routes.post('/jobs/claim', (c) => c.json({ job: store.claim() ?? null }));

    routes.post('/jobs/:id/result', async (c) => {
        const result = analysisResultSchema.safeParse(await readJson(c));
        if (!result.success) throw new AppError('VALIDATION_FAILED', 'The result does not match the contract');
        return c.json({ accepted: store.complete(jobId(c.req.param('id')), result.data) });
    });

    routes.post('/jobs/:id/failure', async (c) => {
        const failure = analysisFailureSchema.safeParse(await readJson(c));
        if (!failure.success) throw new AppError('VALIDATION_FAILED', 'The failure does not match the contract');
        return c.json({ accepted: store.fail(jobId(c.req.param('id')), failure.data) });
    });

    routes.post('/jobs/:id/exports', async (c) => {
        const details = exportDetailsSchema.safeParse(await readJson(c));
        if (!details.success) throw new AppError('VALIDATION_FAILED', 'The export details do not match the contract');
        return c.json({ accepted: store.completeExports(jobId(c.req.param('id')), details.data) });
    });

    routes.post('/jobs/:id/exports-failure', (c) => c.json({ accepted: store.failExports(jobId(c.req.param('id'))) }));

    return routes;
};
