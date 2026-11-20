import type { Config } from '@config/env.ts';
import { AppError } from '@platform/errors.ts';
import { addressIn, clientKey } from '@platform/http/client-key.ts';
import { createRateLimiter, type RateLimitResult } from '@platform/rate-limit.ts';
import { sameSecret } from '@platform/secrets.ts';

/** What of a request decides whose share it counts against, and which shares. */
export type Caller = {
    method: string;
    path: string;
    /** What `x-internal-token` says: the frontend's own server rendering proves itself with it. */
    internalToken: string | undefined;
    /** What `x-visitor-ip` says: the visitor a rendering asks on behalf of. Read only from a rendering. */
    visitor: string | undefined;
    /** What the trusted proxy wrote into `CLIENT_IP_HEADER`, when one is configured. */
    proxied: string | undefined;
    socketAddress: string | undefined;
};

/** What the routes mounted on the shell say of themselves: the platform knows no module's paths. */
export type CallerRoutes = {
    /** Costs no share at all, such as a health check. */
    isFree: (path: string) => boolean;
    /** Always queues packages to be downloaded, so each request counts against the caller's share of queueing. */
    alwaysQueues: (method: string, path: string) => boolean;
    /** Answers agents, whose calls count against shares of their own too. */
    isForAgents: (path: string) => boolean;
};

export type CallerShares = {
    /** The share the caller can plan by, for the `RateLimit-*` headers; when it is not allowed, the request is refused. */
    result: RateLimitResult;
    /**
     * Counts one package added to the queue against the caller's share of queueing, and throws RATE_LIMITED past it.
     * Called by a route at the moment it queues, so reading what is already known costs none of that share.
     */
    queueShare: () => void;
};

type Limits = Pick<
    Config,
    'RATE_LIMIT_PER_MINUTE' | 'RATE_LIMIT_RENDER_PER_MINUTE' | 'RATE_LIMIT_QUEUE_PER_MINUTE' | 'RATE_LIMIT_MCP_PER_MINUTE' | 'RATE_LIMIT_MCP_TOTAL_PER_MINUTE' | 'INTERNAL_API_TOKEN'
>;

/**
 * Every caller gets a share of the API. The frontend's own server rendering proves itself with the shared token and asks
 * on behalf of every visitor at once: each visitor it names gets a share of its own (larger, since one page asks for
 * several things). Queueing packages, which has the worker download them, counts against a much smaller share, so a
 * crawler or a script cannot fill the queue by opening pages: a route that always queues counts each request, and any
 * other counts when it adds a package to the queue (`queueShare`). Answers `undefined` for a request that costs nothing.
 */
export const createCallerShares = (limits: Limits, routes: CallerRoutes, now: () => number = Date.now) => {
    const limiterOf = (limit: number) => createRateLimiter({ limit, windowMs: 60_000, now });
    const limiter = limiterOf(limits.RATE_LIMIT_PER_MINUTE);
    const renderLimiter = limiterOf(limits.RATE_LIMIT_RENDER_PER_MINUTE);
    const queueLimiter = limiterOf(limits.RATE_LIMIT_QUEUE_PER_MINUTE);
    // An agent's calls count against shares of their own too, per caller and all callers together: the total holds MCP to a
    // fixed part of the server whatever the number of addresses, and over it agents wait, visitors do not.
    const mcpLimiter = limiterOf(limits.RATE_LIMIT_MCP_PER_MINUTE);
    const mcpTotalLimiter = limiterOf(limits.RATE_LIMIT_MCP_TOTAL_PER_MINUTE);
    const internalToken = limits.INTERNAL_API_TOKEN;

    // A render that names no visitor is a document for crawlers (the sitemap, a share image), or a rendering that has
    // lost sight of its visitors (no proxy header behind a proxy): either way, all of them share one render-sized count,
    // so the token alone never means "unlimited". A visitor that is no address is not a way around the limit either.
    const renderKey = (visitor: string | undefined): string => {
        const named = visitor?.trim();
        if (named === undefined || named === '') return 'render:none';
        return addressIn(named) === undefined ? 'render:invalid' : clientKey(named, undefined);
    };

    return (caller: Caller): CallerShares | undefined => {
        if (routes.isFree(caller.path)) return undefined;
        const rendering = internalToken !== undefined && caller.internalToken !== undefined && sameSecret(caller.internalToken, internalToken);
        const key = rendering ? renderKey(caller.visitor) : clientKey(caller.proxied, caller.socketAddress);
        let result = (rendering ? renderLimiter : limiter).hit(key);
        if (result.allowed && routes.alwaysQueues(caller.method, caller.path)) result = queueLimiter.hit(key);
        if (result.allowed && routes.isForAgents(caller.path)) {
            result = mcpLimiter.hit(key);
            if (result.allowed) {
                // The headers report the caller's own share, the one it can plan by; the total speaks only when it says no.
                const total = mcpTotalLimiter.hit('all');
                if (!total.allowed) result = total;
            }
        }
        return {
            result,
            queueShare: () => {
                const share = queueLimiter.hit(key);
                if (!share.allowed) throw new AppError('RATE_LIMITED', 'Too many packages asked to be measured; retry after the time in Retry-After', undefined, share.resetSeconds);
            },
        };
    };
};
