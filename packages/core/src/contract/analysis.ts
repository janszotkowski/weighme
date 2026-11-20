import * as z from 'zod/mini';

/**
 * Which way of measuring a stored result came from. Bump it when the bundler or its settings change: results of the old
 * value are no longer served, and each package is measured again the next time someone asks for it.
 */
export const ANALYZER_VERSION = 8;

export const packageRefSchema = z.object({ name: z.string(), version: z.string() });

export type PackageRef = z.infer<typeof packageRefSchema>;

/**
 * How the package is imported for measuring. ESM takes `export *` and its default export, which keeps its tree-shaking. CommonJS takes the
 * namespace: bundlers cannot see the exports of `export *` over CommonJS and would measure an empty module.
 */
export const ENTRY_KINDS = ['export-star', 'namespace'] as const;

export const analysisResultSchema = z.object({
    bundler: z.object({ name: z.string(), version: z.string() }),
    /** Null, like `sizes`, for a package with nothing to import, such as a command-line tool: there is no bundle to measure. */
    entry: z.nullable(z.enum(ENTRY_KINDS)),
    /** Bytes of the minified bundle, without peer dependencies. */
    sizes: z.nullable(z.object({ minified: z.number(), gzip: z.number(), brotli: z.number() })),
    /**
     * The packages in the bundle, largest first, each with its share of it (0 to 1) and how many of its files are in it.
     * `total` counts them all; the list holds the largest ones. Empty when there is no bundle.
     */
    composition: z.object({ packages: z.array(z.object({ name: z.string(), share: z.number(), modules: z.number() })), total: z.number() }),
    /** The commands the package installs (its `bin`). */
    commands: z.array(z.string()),
    /** What an install puts on disk. */
    install: z.object({ bytes: z.number(), packages: z.number() }),
    peerDependencies: z.array(z.string()),
    /** What its author says it is: similar names are often entirely different packages. */
    description: z.nullable(z.string()),
    /**
     * What the package needs that a browser does not have, or that could not be found. None of it is in the sizes, so any
     * of it means the numbers are not what the package costs in a browser.
     */
    environment: z.object({ nodeBuiltins: z.array(z.string()), nativeAddons: z.number(), unresolvedImports: z.number() }),
    /** The package's page on GitHub, when it names one. It becomes a link, so nothing else gets through. */
    repositoryUrl: z.nullable(z.string().check(z.regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\/tree\/HEAD\/[\w@./-]+)?$/))),
    timingsMs: z.object({ install: z.number(), bundle: z.number(), compress: z.number() }),
});

export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export const FAILURE_CODES = ['INSTALL_FAILED', 'BUNDLE_FAILED', 'TOO_LARGE', 'TIMEOUT', 'INTERNAL'] as const;

export const analysisFailureSchema = z.object({ code: z.enum(FAILURE_CODES), message: z.string() });

export type AnalysisFailure = z.infer<typeof analysisFailureSchema>;

/** What importing one part costs, measured on its own (bytes). */
export const partSizeSchema = z.object({ minified: z.number(), gzip: z.number() });

/**
 * What a package costs part by part. `namedTotal` and `subpathsTotal` count everything found: a part in neither its list
 * nor its failed count was not reached within the worker's limits.
 */
export const exportDetailsSchema = z.object({
    /** CommonJS cannot be tree-shaken reliably, so it has no named exports here. */
    format: z.enum(['esm', 'commonjs']),
    /** The package declares `"sideEffects": false`: bundlers may drop whole files of it. */
    sideEffectsFree: z.boolean(),
    named: z.array(z.extend(partSizeSchema, { name: z.string() })),
    namedTotal: z.number(),
    namedFailed: z.number(),
    /** The paths in `exports` other than the root, such as `./client`. */
    subpaths: z.array(z.extend(partSizeSchema, { path: z.string() })),
    subpathsTotal: z.number(),
    subpathsFailed: z.number(),
    /** Paths with a wildcard (`./*`): they stand for files, so they are not measured one by one. */
    subpathPatterns: z.number(),
});

export type ExportDetails = z.infer<typeof exportDetailsSchema>;

/** The part-by-part numbers come after the main result: `pending` is asked for again. */
export const exportsStateSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('pending') }),
    z.object({ status: z.literal('done'), details: exportDetailsSchema }),
    z.object({ status: z.literal('unavailable') }),
]);

export type ExportsState = z.infer<typeof exportsStateSchema>;

const base = { package: packageRefSchema, analyzerVersion: z.number() };

/** The answer of `GET /v1/analyses`: a queued or running analysis is asked for again until it is `done` or `failed`. */
export const analysisResponseSchema = z.discriminatedUnion('status', [
    z.object({ ...base, status: z.literal('queued') }),
    z.object({ ...base, status: z.literal('running') }),
    z.object({ ...base, status: z.literal('done'), result: analysisResultSchema, exports: exportsStateSchema }),
    z.object({ ...base, status: z.literal('failed'), failure: analysisFailureSchema }),
]);

export type AnalysisResponse = z.infer<typeof analysisResponseSchema>;

/**
 * Everything of a finished analysis has arrived: the result and the part-by-part numbers, or the news that there are
 * none. Only such an answer is worth keeping; anything else is asked for again.
 */
export const isComplete = (answer: AnalysisResponse): boolean => answer.status === 'done' && answer.exports.status !== 'pending';

/** The most packages `GET /v1/packages` lists: what one sitemap file may hold. */
export const MAX_LISTED_PACKAGES = 50_000;

/** The answer of `GET /v1/packages`: every package with a finished measurement, which is what is worth listing to a crawler. */
export const packagesResponseSchema = z.object({ packages: z.array(z.object({ name: z.string(), measuredAt: z.string() })) });

export type PackagesResponse = z.infer<typeof packagesResponseSchema>;

/** One package for the worker to measure (`POST /internal/jobs/claim`). */
export const jobSchema = z.object({ id: z.number(), package: packageRefSchema });

export type Job = z.infer<typeof jobSchema>;

export const claimResponseSchema = z.object({ job: z.nullable(jobSchema) });
