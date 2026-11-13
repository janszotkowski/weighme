import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { etag, RETAINED_304_HEADERS } from 'hono/etag';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { Config } from '@config/env.ts';
import { AppError, errorBody, statusOf } from '@platform/errors.ts';
import { addressIn, clientKey } from '@platform/http/client-key.ts';
import type { Logger } from '@platform/logger.ts';
import { createRateLimiter } from '@platform/rate-limit.ts';

// The Node bindings are optional: tests call `app.request` without a socket.
export type AppEnv = {
    Bindings: Partial<HttpBindings>;
    Variables: {
        requestId: string;
        logger: Logger;
        /** The API error code of a failed request, for the access log. */
        errorCode?: string;
        /**
         * Counts one package added to the queue against the caller's share of queueing, and throws RATE_LIMITED past it.
         * Called by a route at the moment it queues, so reading what is already known costs none of that share.
         */
        queueShare: () => void;
    };
};

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** A frontend on this machine, on whatever port the dev server picked. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** What a browser's script may read of an answer from another origin: the request id and how much of the share is left. */
const EXPOSED_HEADERS = ['X-Request-Id', 'Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'];

/** Public requests carry no body worth speaking of (`POST /v1/history` has none); the worker's results, which do, come in under `/internal`. */
const PUBLIC_BODY_BYTES = 16 * 1024;

/** A 304 keeps what the equivalent 200 would have said about itself, including who may read it and how much of the share is left. */
const RETAINED_ON_304 = [...RETAINED_304_HEADERS, 'x-request-id', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'access-control-allow-origin', 'access-control-expose-headers'];

/** The origins named in the configuration; with none named (development only, production requires them), any local one. */
export const allowedOrigin = (configured: readonly string[], origin: string): string | undefined => {
    if (configured.length > 0) return configured.includes(origin) ? origin : undefined;
    return LOCAL_ORIGIN.test(origin) ? origin : undefined;
};

/** Compares secrets in constant time; hashing first makes the lengths equal, which `timingSafeEqual` requires. */
export const sameSecret = (given: string, expected: string): boolean => timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());

/** What always queues packages to be downloaded, so each request counts against the caller's share of queueing. */
const QUEUES_WORK = (method: string, path: string): boolean => method === 'POST' && path === '/v1/history';

const TOO_MANY = 'Too many requests; slow down and retry after the time in Retry-After';

/** The HTTP shell every module plugs into: request id, access log, CORS, security headers, the rate limit and one place that turns failures into the error contract. */
export const createBaseApp = (deps: { config: Config; logger: Logger }): Hono<AppEnv> => {
    const app = new Hono<AppEnv>();

    app.use(async (c, next) => {
        // A caller-supplied id is accepted only in a safe shape: it ends up in logs.
        const incoming = c.req.header('x-request-id');
        const requestId = incoming !== undefined && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        c.set('requestId', requestId);
        c.set('logger', deps.logger.child({ requestId }));
        // Set before the handlers run, so that an answer a middleware gives on its own (a body too large) carries it too.
        c.header('x-request-id', requestId);
        const started = performance.now();
        await next();
        const errorCode = c.get('errorCode');
        // The worker asks for work every second: at `info` that would bury every other line. What it handles, it logs itself.
        const level = c.req.path === '/internal/jobs/claim' && c.res.ok ? 'debug' : 'info';
        c.var.logger[level](
            {
                method: c.req.method,
                // Caller-controlled text is cut short: a 16 KB URL must not become a 16 KB log line.
                path: c.req.path.slice(0, 200),
                // A pattern ending in `/*` is a middleware's: no route matched (404) or a middleware answered (a body too large).
                route: c.req.routePath.endsWith('/*') ? null : c.req.routePath,
                status: c.res.status,
                durationMs: Math.round(performance.now() - started),
                ...(errorCode === undefined ? {} : { errorCode }),
            },
            'request',
        );
    });
    app.use('/v1/*', cors({ origin: (origin) => allowedOrigin(deps.config.CORS_ORIGINS, origin), allowMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'], exposeHeaders: EXPOSED_HEADERS, maxAge: 86_400 }));
    app.use(secureHeaders());
    app.use(
        '/v1/*',
        bodyLimit({
            maxSize: PUBLIC_BODY_BYTES,
            onError: (c) => {
                c.set('errorCode', 'VALIDATION_FAILED');
                return c.json(errorBody('VALIDATION_FAILED', 'The request body is too large', c.get('requestId')), statusOf('VALIDATION_FAILED'));
            },
        }),
    );

    // Every caller gets a share of the API; health checks are free. The frontend's own server rendering proves itself with
    // the shared token and asks on behalf of every visitor at once: each visitor it names gets a share of its own (larger,
    // since one page asks for several things). Queueing packages, which has the worker download them, counts against a
    // much smaller share, so a crawler or a script cannot fill the queue by opening pages: a request for a package's
    // versions always does, and one for a package's cost when it adds that package to the queue (`queueShare`).
    const limiter = createRateLimiter({ limit: deps.config.RATE_LIMIT_PER_MINUTE, windowMs: 60_000 });
    const renderLimiter = createRateLimiter({ limit: deps.config.RATE_LIMIT_RENDER_PER_MINUTE, windowMs: 60_000 });
    const queueLimiter = createRateLimiter({ limit: deps.config.RATE_LIMIT_QUEUE_PER_MINUTE, windowMs: 60_000 });
    // An agent's calls count against shares of their own too, per caller and all callers together: the total holds MCP to a
    // fixed part of the server whatever the number of addresses, and over it agents wait, visitors do not.
    const mcpLimiter = createRateLimiter({ limit: deps.config.RATE_LIMIT_MCP_PER_MINUTE, windowMs: 60_000 });
    const mcpTotalLimiter = createRateLimiter({ limit: deps.config.RATE_LIMIT_MCP_TOTAL_PER_MINUTE, windowMs: 60_000 });
    const internalToken = deps.config.INTERNAL_API_TOKEN;
    app.use('/v1/*', async (c, next) => {
        if (c.req.path === '/v1/health') return next();
        const token = c.req.header('x-internal-token');
        const rendering = internalToken !== undefined && token !== undefined && sameSecret(token, internalToken);
        const visitor = rendering ? c.req.header('x-visitor-ip')?.trim() : undefined;
        const header = deps.config.CLIENT_IP_HEADER === undefined ? undefined : c.req.header(deps.config.CLIENT_IP_HEADER);
        // A render that names no visitor is a document for crawlers (the sitemap, a share image), or a rendering that has
        // lost sight of its visitors (no proxy header behind a proxy): either way, all of them share one render-sized count,
        // so the token alone never means "unlimited". A visitor that is no address is not a way around the limit either.
        const renderKey = (): string => {
            if (visitor === undefined || visitor === '') return 'render:none';
            return addressIn(visitor) === undefined ? 'render:invalid' : clientKey(visitor, undefined);
        };
        const key = rendering ? renderKey() : clientKey(header, c.env?.incoming?.socket.remoteAddress);
        c.set('queueShare', () => {
            const share = queueLimiter.hit(key);
            if (!share.allowed) throw new AppError('RATE_LIMITED', 'Too many packages asked to be measured; retry after the time in Retry-After', undefined, share.resetSeconds);
        });
        let result = (rendering ? renderLimiter : limiter).hit(key);
        if (result.allowed && QUEUES_WORK(c.req.method, c.req.path)) result = queueLimiter.hit(key);
        if (result.allowed && c.req.path.startsWith('/v1/mcp')) {
            result = mcpLimiter.hit(key);
            if (result.allowed) {
                // The headers report the caller's own share, the one it can plan by; the total speaks only when it says no.
                const total = mcpTotalLimiter.hit('all');
                if (!total.allowed) result = total;
            }
        }
        c.header('ratelimit-limit', String(result.limit));
        c.header('ratelimit-remaining', String(result.remaining));
        c.header('ratelimit-reset', String(result.resetSeconds));
        if (!result.allowed) throw new AppError('RATE_LIMITED', TOO_MANY, undefined, result.resetSeconds);
        return next();
    });

    // Every public answer is hashed, so a browser or CDN that asks again with `If-None-Match` gets a 304 and no body.
    app.get('/v1/*', etag({ retainedHeaders: RETAINED_ON_304 }));

    app.notFound((c) => {
        c.set('errorCode', 'NOT_FOUND');
        return c.json(errorBody('NOT_FOUND', 'There is nothing at this address', c.get('requestId')), statusOf('NOT_FOUND'));
    });
    app.onError((error, c) => {
        const requestId = c.get('requestId');
        if (error instanceof AppError) {
            c.set('errorCode', error.code);
            // A full queue or a silent registry is worth retrying soon; say when.
            const retryAfterSec = error.retryAfterSec ?? (error.code === 'UNAVAILABLE' ? 5 : undefined);
            if (retryAfterSec !== undefined) c.header('retry-after', String(retryAfterSec));
            return c.json(errorBody(error.code, error.message, requestId, error.details), statusOf(error.code));
        }
        // Framework-level client errors are the caller's mistake; their text is the framework's, not the contract's, so it stays inside.
        if (error instanceof HTTPException && error.status < 500) {
            const code = error.status === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED';
            c.set('errorCode', code);
            return c.json(errorBody(code, code === 'NOT_FOUND' ? 'There is nothing at this address' : 'The request is not valid', requestId), statusOf(code));
        }
        // Anything else is a bug: log it with the stack, tell the client nothing about it.
        c.set('errorCode', 'INTERNAL');
        c.var.logger.error({ err: error }, 'unhandled error');
        return c.json(errorBody('INTERNAL', 'Something went wrong', requestId), statusOf('INTERNAL'));
    });

    return app;
};
