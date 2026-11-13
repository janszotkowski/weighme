import * as z from 'zod/mini';
import { analysisResponseSchema, packagesResponseSchema } from './analysis.ts';
import { errorResponseSchema } from './errors.ts';
import { historyResponseSchema } from './history.ts';
import { packageMetadataSchema } from './metadata.ts';
import { MAX_SEARCH_LENGTH, MIN_SEARCH_LENGTH, searchResponseSchema } from './search.ts';
import { TREND_RANGES, downloadsResponseSchema, starsResponseSchema } from './trends.ts';

/**
 * The version of the `/v1` contract, by semantic versioning: the minor grows with every addition (an endpoint, a
 * parameter, a field), the patch with a fix to what is documented. A breaking change is a new path (`/v2`), never this.
 * docs/CHANGELOG.md lists every version.
 */
export const API_VERSION = '1.0.1';

/** The answer of `GET /v1/health`. */
const healthResponseSchema = z.object({ status: z.literal('ok'), version: z.string() });

type JsonSchema = Record<string, unknown>;

/**
 * A response schema as JSON Schema (2020-12, which OpenAPI 3.1 uses). Objects are left open: new fields are added to
 * `/v1` without notice, and a generated client must not reject them.
 */
const jsonSchema = (schema: z.ZodMiniType): JsonSchema => {
    const open = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(open);
        if (node === null || typeof node !== 'object') return node;
        return Object.fromEntries(Object.entries(node).flatMap(([key, value]) => (key === '$schema' || (key === 'additionalProperties' && value === false) ? [] : [[key, open(value)]])));
    };
    return open(z.toJSONSchema(schema)) as JsonSchema;
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const json = (name: string, description: string) => ({ description, content: { 'application/json': { schema: ref(name) } } });

const required = (name: string, description: string, schema: JsonSchema) => ({ name, in: 'query', required: true, description, schema });

const optional = (name: string, description: string, schema: JsonSchema) => ({ name, in: 'query', required: false, description, schema });

const PACKAGE_NAME = required('package', 'A package name, without a version.', { type: 'string', example: 'react' });

const ERROR_DESCRIPTIONS = {
    '400': 'VALIDATION_FAILED: a malformed parameter',
    '404': 'NOT_FOUND: not on npm, or not measured with `known=1`',
    '429': 'RATE_LIMITED: wait for `Retry-After` seconds',
    '503': 'UNAVAILABLE: the queue is full or the registry did not answer; retry after `Retry-After`',
    '500': 'INTERNAL: quote the `requestId`',
} as const;

/** The error answers of an operation; any of them may be a 500. */
const errors = (...statuses: Array<Exclude<keyof typeof ERROR_DESCRIPTIONS, '500'>>) =>
    Object.fromEntries([...statuses, '500' as const].map((status) => [status, json('Error', ERROR_DESCRIPTIONS[status])]));

const operation = (operationId: string, summary: string, parameters: unknown[], response: Record<string, unknown>, failures: Record<string, unknown>) => ({
    operationId,
    summary,
    parameters,
    responses: { '200': response, ...failures },
});

export type OpenApiOptions = {
    /** Requests one caller may make per minute, as the API is configured. */
    rateLimitPerMinute?: number;
    /** Where the human-readable reference lives. */
    docsUrl?: string;
};

/**
 * The OpenAPI 3.1 description of `/v1`, served at `/v1/openapi.json`. The response shapes come from the zod schemas the
 * API itself is checked against, so this cannot drift from what is sent; the prose lives in docs/API.md.
 */
export const openApiDocument = ({ rateLimitPerMinute = 300, docsUrl = 'https://github.com/janszotkowski/weighme/blob/main/docs/API.md' }: OpenApiOptions = {}) => ({
    openapi: '3.1.0',
    info: {
        title: 'weighme API',
        version: API_VERSION,
        summary: 'Free, public API: what an npm package costs a bundle, measured by really bundling it.',
        description: `No key, JSON. Each caller may make ${rateLimitPerMinute} requests per minute (\`RateLimit-*\` headers). Full reference with examples: ${docsUrl}. The same data is available to AI agents over the Model Context Protocol at \`/v1/mcp\`, which is not described here.`,
        license: { name: 'MIT', identifier: 'MIT' },
    },
    externalDocs: { description: 'API reference', url: docsUrl },
    // Relative to where this document is served, so it is right on any host the API runs on.
    servers: [{ url: '/v1' }],
    // Public: no key, no account.
    security: [],
    paths: {
        '/analyses': {
            get: operation(
                'getAnalysis',
                'What a package costs. A package not measured yet is queued, unless `known=1`',
                [
                    required('package', 'A name with an optional exact version or dist-tag.', { type: 'string', example: 'react@19.1.0' }),
                    optional('known', '`1`: read only what has been measured, and never queue a download. Not measured is a 404.', { type: 'string', enum: ['1'] }),
                    optional('analyzer', 'The analyzer version the caller expects. Ignored by the API; it keeps a cached answer from outliving a change in how packages are measured.', {
                        type: 'integer',
                    }),
                ],
                json('AnalysisResponse', 'The analysis: queued, running, done or failed'),
                errors('400', '404', '429', '503'),
            ),
        },
        '/history': {
            get: operation(
                'getHistory',
                'Recent versions of a package, with the sizes of the measured ones. Downloads nothing',
                [PACKAGE_NAME],
                json('HistoryResponse', 'Newest first'),
                errors('400', '404', '429', '503'),
            ),
            post: operation(
                'measureHistory',
                'Queues every version not measured yet, behind what someone is waiting for. Has a much smaller rate limit of its own',
                [PACKAGE_NAME],
                json('HistoryResponse', 'Newest first'),
                errors('400', '404', '429', '503'),
            ),
        },
        '/downloads': {
            get: operation(
                'getDownloads',
                'Downloads of a package per day, oldest first',
                [PACKAGE_NAME, required('range', 'How far back.', { type: 'string', enum: [...TREND_RANGES] })],
                json('DownloadsResponse', 'One row per day, in UTC'),
                errors('400', '404', '429', '503'),
            ),
        },
        '/metadata': {
            get: operation(
                'getMetadata',
                'What the registry says of one version: deprecation, license, types, install scripts. Downloads nothing',
                [required('package', 'A name with an exact version.', { type: 'string', example: 'react@19.1.0' })],
                json('PackageMetadata', 'The version'),
                errors('400', '404', '429', '503'),
            ),
        },
        '/stars': {
            get: operation(
                'getStars',
                'GitHub stars of a repository, today',
                [required('repository', 'The repository as `owner/name`.', { type: 'string', example: 'facebook/react' })],
                json('StarsResponse', 'Null when GitHub did not say, and for a repository no measured package names'),
                errors('400', '429', '503'),
            ),
        },
        '/search': {
            get: operation(
                'search',
                'Packages matching a text: names and descriptions only, nothing is installed',
                [required('q', `What to look for, ${MIN_SEARCH_LENGTH}–${MAX_SEARCH_LENGTH} characters.`, { type: 'string', minLength: MIN_SEARCH_LENGTH, maxLength: MAX_SEARCH_LENGTH })],
                json('SearchResponse', 'The matches'),
                errors('400', '429', '503'),
            ),
        },
        '/packages': { get: operation('listPackages', 'Every package with a finished measurement', [], json('PackagesResponse', 'Up to 50,000'), errors('429')) },
        '/health': { get: operation('health', 'Whether the API is up, and which build', [], json('HealthResponse', 'Up'), {}) },
    },
    components: {
        schemas: {
            AnalysisResponse: jsonSchema(analysisResponseSchema),
            HistoryResponse: jsonSchema(historyResponseSchema),
            DownloadsResponse: jsonSchema(downloadsResponseSchema),
            PackageMetadata: jsonSchema(packageMetadataSchema),
            StarsResponse: jsonSchema(starsResponseSchema),
            SearchResponse: jsonSchema(searchResponseSchema),
            PackagesResponse: jsonSchema(packagesResponseSchema),
            HealthResponse: jsonSchema(healthResponseSchema),
            Error: jsonSchema(errorResponseSchema),
        },
    },
});
