import {
    MAX_SEARCH_LENGTH,
    MIN_SEARCH_LENGTH,
    analysisFailureSchema,
    analysisResultSchema,
    exportDetailsSchema,
    TREND_RANGES,
    isComplete,
    isExactVersion,
    openApiDocument,
    parseSpec,
    type AnalysisResponse,
    type HistoryResponse,
    type PackageSpec,
    type VersionEntry,
} from '@weighme/core';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { DownloadsReader, MetadataReader, PackageSearcher, ReleasedVersion, StarsReader, VersionLister, VersionResolver } from '@modules/analyses/infrastructure/registry.ts';
import type { AnalysisStore, VersionSummary } from '@modules/analyses/infrastructure/store.ts';
import { AppError } from '@platform/errors.ts';
import { sameSecret, type AppEnv } from '@platform/http/app.ts';

/**
 * Everything public is the same for every caller, so a CDN in front may keep it (`s-maxage`) and serve it a while longer
 * while it asks again (`stale-while-revalidate`); the browser's own copy (`max-age`) is kept shorter. What is still being
 * measured is `no-store`: the page polls it. A finished result of an exact version does not change until the analyzer does.
 */
const SHORT_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';
const DETAIL_CACHE = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=3600';
const EXACT_CACHE = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400';

const REPOSITORY = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
/** What one sitemap file may hold. */
const MAX_LISTED_PACKAGES = 50_000;

/** What the public routes read from: npm and GitHub in production; tests pass their own, so they never reach the network. */
export type AnalysisDeps = {
    store: AnalysisStore;
    resolve: VersionResolver;
    search: PackageSearcher;
    listVersions: VersionLister;
    readDownloads: DownloadsReader;
    readStars: StarsReader;
    readMetadata: MetadataReader;
};

const STATUSES: readonly VersionEntry['status'][] = ['queued', 'running', 'done', 'failed'];

const versionEntry = (released: ReleasedVersion, known: VersionSummary | undefined): VersionEntry => {
    const { version, publishedAt } = released;
    const status = STATUSES.find((candidate) => candidate === known?.status);
    if (known === undefined || status === undefined) return { version, publishedAt, status: 'unmeasured', gzip: null, minified: null };
    return { version, publishedAt, status, gzip: status === 'done' ? known.gzip : null, minified: status === 'done' ? known.minified : null };
};

/**
 * A package's analysis, queued when there is none. An exact version already in the store needs no question to the
 * registry: polling costs it nothing. A failed one is asked about again, so that a version taken off npm meanwhile is not queued once more.
 * `queueShare` is the caller's share of queueing (`AppEnv`): counted only when this adds the package to the queue.
 */
export const lookUpAnalysis = async (deps: Pick<AnalysisDeps, 'store' | 'resolve'>, spec: PackageSpec, queueShare: () => void): Promise<AnalysisResponse> => {
    const exact = spec.version !== undefined && isExactVersion(spec.version) ? spec.version : undefined;
    const known = exact === undefined ? undefined : deps.store.find({ name: spec.name, version: exact });
    if (known !== undefined && known.status !== 'failed') return known;
    return deps.store.findOrEnqueue({ name: spec.name, version: await deps.resolve(spec.name, spec.version ?? 'latest') }, queueShare);
};

/** A name without a version, from the `package` parameter. */
const packageName = (value: string | undefined): string => {
    const spec = parseSpec(value ?? '');
    if (spec === undefined || spec.version !== undefined) throw new AppError('VALIDATION_FAILED', 'package must be a name without a version');
    return spec.name;
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
    const { store, resolve, search, listVersions, readDownloads, readStars, readMetadata } = deps;
    const routes = new Hono<AppEnv>();

    // The contract for generated clients; it changes only with a deployment.
    const openApi = openApiDocument({ rateLimitPerMinute: options.rateLimitPerMinute });
    routes.get('/openapi.json', (c) => {
        c.header('cache-control', 'public, max-age=3600, s-maxage=3600');
        return c.json(openApi);
    });

    const history = async (name: string): Promise<HistoryResponse> => {
        const released = await listVersions(name);
        const known = store.summaries(name);
        return { name, versions: released.map((version) => versionEntry(version, known.get(version.version))) };
    };

    routes.get('/history', async (c) => {
        c.header('cache-control', 'no-store');
        return c.json(await history(packageName(c.req.query('package'))));
    });

    // Measuring downloads every version, so it is only ever asked for, never done because a page was opened.
    routes.post('/history', async (c) => {
        const name = packageName(c.req.query('package'));
        store.enqueueLater((await listVersions(name)).map(({ version }) => ({ name, version })));
        c.header('cache-control', 'no-store');
        return c.json(await history(name));
    });

    routes.get('/analyses', async (c) => {
        const spec = parseSpec(c.req.query('package') ?? '');
        if (spec === undefined) throw new AppError('VALIDATION_FAILED', 'package must be a name with an optional exact version or dist-tag, such as react or react@19.1.0');
        const exact = spec.version !== undefined && isExactVersion(spec.version) ? spec.version : undefined;

        // Documents for crawlers ask with `known=1`: they read what has been measured, and never cause a download.
        if (c.req.query('known') === '1') {
            const version = exact ?? (await resolve(spec.name, spec.version ?? 'latest'));
            const found = store.find({ name: spec.name, version });
            if (found === undefined) throw new AppError('NOT_FOUND', `${spec.name}@${version} has not been measured`);
            c.header('cache-control', isComplete(found) ? (exact === undefined ? SHORT_CACHE : EXACT_CACHE) : 'no-store');
            return c.json(found);
        }

        const answer = await lookUpAnalysis(deps, spec, c.get('queueShare'));

        // What a tag points to changes with the next release; the result of an exact version does not.
        c.header('cache-control', isComplete(answer) ? (exact === undefined ? SHORT_CACHE : EXACT_CACHE) : 'no-store');
        return c.json(answer);
    });

    routes.get('/packages', (c) => {
        c.header('cache-control', DETAIL_CACHE);
        return c.json({ packages: store.measuredPackages(MAX_LISTED_PACKAGES) });
    });

    routes.get('/downloads', async (c) => {
        const name = packageName(c.req.query('package'));
        const range = TREND_RANGES.find((candidate) => candidate === c.req.query('range'));
        if (range === undefined) throw new AppError('VALIDATION_FAILED', `range must be one of ${TREND_RANGES.join(', ')}`);
        c.header('cache-control', DETAIL_CACHE);
        return c.json({ name, days: await readDownloads(name, range) });
    });

    routes.get('/stars', async (c) => {
        const repository = c.req.query('repository') ?? '';
        if (!REPOSITORY.test(repository) || repository.split('/').some((part) => part.startsWith('.'))) throw new AppError('VALIDATION_FAILED', 'repository must be owner/name');
        c.header('cache-control', DETAIL_CACHE);
        // GitHub is asked only about the repository of a package measured here: any other name would spend the few
        // questions it allows on whatever a caller made up.
        return c.json({ stars: store.knowsRepository(repository) ? await readStars(repository) : null });
    });

    // Only what the registry says about the version: nothing is queued or downloaded for this.
    routes.get('/metadata', async (c) => {
        const spec = parseSpec(c.req.query('package') ?? '');
        const version = spec?.version;
        if (spec === undefined || version === undefined || !isExactVersion(version)) throw new AppError('VALIDATION_FAILED', 'package must be a name with an exact version, such as react@19.1.0');
        c.header('cache-control', DETAIL_CACHE);
        return c.json(await readMetadata(spec.name, version));
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
