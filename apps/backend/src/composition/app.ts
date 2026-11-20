import type { Hono } from 'hono';
import type { Config } from '@config/env.ts';
import { createAnalyses, type AnalysesDeps } from '@modules/analyses/application/analyses.ts';
import type { DownloadsReader, PackageSearcher } from '@modules/analyses/application/ports.ts';
import { mcpRoutes } from '@modules/analyses/http/mcp.ts';
import { analysisRoutes, workerRoutes } from '@modules/analyses/http/routes.ts';
import type { AnalysisStore } from '@modules/analyses/infrastructure/store.ts';
import { createBaseApp, type AppEnv } from '@platform/http/app.ts';
import type { Logger } from '@platform/logger.ts';

/** Everything the API is built from. The readers are npm and GitHub in production; tests pass their own, so they never reach the network. */
export type Container = AnalysesDeps & {
    store: AnalysisStore;
    search: PackageSearcher;
    readDownloads: DownloadsReader;
    config: Config;
    logger: Logger;
};

/** The whole API: the HTTP shell with the public routes under `/v1` and the worker's under `/internal`. */
export const createApp = (container: Container): Hono<AppEnv> => {
    // The shell counts every request against its caller's share, and is told here which of the routes mounted below are special.
    const app = createBaseApp(container, {
        isFree: (path) => path === '/v1/health',
        alwaysQueues: (method, path) => method === 'POST' && path === '/v1/history',
        isForAgents: (path) => path.startsWith('/v1/mcp'),
    });
    const analyses = createAnalyses(container);
    app.get('/v1/health', (c) => {
        c.header('cache-control', 'no-store');
        return c.json({ status: 'ok' as const, version: container.config.APP_VERSION });
    });
    if (container.config.MCP_ENABLED) {
        app.route(
            '/v1/mcp',
            mcpRoutes({
                analyses,
                logger: container.logger,
                corsOrigins: container.config.CORS_ORIGINS,
                version: container.config.APP_VERSION,
            }),
        );
    }
    app.route('/v1', analysisRoutes({ analyses, search: container.search, readDownloads: container.readDownloads }, { rateLimitPerMinute: container.config.RATE_LIMIT_PER_MINUTE }));
    app.route('/internal', workerRoutes(container.store, container.config.WORKER_TOKEN, container.config.CLIENT_IP_HEADER));
    return app;
};
