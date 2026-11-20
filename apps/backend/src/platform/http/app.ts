import { randomUUID } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { etag, RETAINED_304_HEADERS } from 'hono/etag';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { Config } from '@config/env.ts';
import { AppError, errorBody, statusOf } from '@platform/errors.ts';
import { createCallerShares, type CallerRoutes } from '@platform/http/caller-shares.ts';
import type { Logger } from '@platform/logger.ts';

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

const TOO_MANY = 'Too many requests; slow down and retry after the time in Retry-After';

/**
 * The HTTP shell every module plugs into: request id, access log, CORS, security headers, the rate limit and one place
 * that turns failures into the error contract. `routes` is what the routes mounted on it say of themselves, for the limit.
 */
export const createBaseApp = (deps: { config: Config; logger: Logger }, routes: CallerRoutes): Hono<AppEnv> => {
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

    // Every caller gets a share of the API, and a smaller one of queueing (`createCallerShares`).
    const sharesOf = createCallerShares(deps.config, routes);
    app.use('/v1/*', async (c, next) => {
        const shares = sharesOf({
            method: c.req.method,
            path: c.req.path,
            internalToken: c.req.header('x-internal-token'),
            visitor: c.req.header('x-visitor-ip'),
            proxied: deps.config.CLIENT_IP_HEADER === undefined ? undefined : c.req.header(deps.config.CLIENT_IP_HEADER),
            socketAddress: c.env?.incoming?.socket.remoteAddress,
        });
        if (shares === undefined) return next();
        c.set('queueShare', shares.queueShare);
        c.header('ratelimit-limit', String(shares.result.limit));
        c.header('ratelimit-remaining', String(shares.result.remaining));
        c.header('ratelimit-reset', String(shares.result.resetSeconds));
        if (!shares.result.allowed) throw new AppError('RATE_LIMITED', TOO_MANY, undefined, shares.result.resetSeconds);
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
