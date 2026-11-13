import { serve } from '@hono/node-server';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, errorResponseSchema, type AnalysisResult } from '@weighme/core';
import { createApp, type Container } from '@composition/app.ts';
import { loadConfig } from '@config/env.ts';
import { openDatabase } from '@modules/analyses/infrastructure/database.ts';
import { createAnalysisStore } from '@modules/analyses/infrastructure/store.ts';
import { AppError } from '@platform/errors.ts';
import { createLogger } from '@platform/logger.ts';

const WORKER_TOKEN = 'test-worker-token-of-at-least-32-characters';
const INTERNAL_API_TOKEN = 'test-render-token-of-at-least-32-characters';

const RESULT: AnalysisResult = {
    bundler: { name: 'rolldown', version: '1.0.0' },
    entry: 'export-star',
    commands: [],
    composition: { packages: [{ name: 'example', share: 1, modules: 1 }], total: 1 },
    sizes: { minified: 300, gzip: 200, brotli: 100 },
    install: { bytes: 1000, packages: 1 },
    peerDependencies: [],
    description: 'An example',
    environment: { nodeBuiltins: [], nativeAddons: 0, unresolvedImports: 0 },
    repositoryUrl: 'https://github.com/owner/example',
    timingsMs: { install: 1, bundle: 1, compress: 1 },
};

/** The log lines as JSON, for the tests that read what the shell wrote. */
const capture = () => {
    const lines: string[] = [];
    return { lines, stream: { write: (line: string) => void lines.push(line) }, entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
};

/** The API over an in-memory store, with the registry and GitHub stood in for: nothing here reaches the network. */
const setup = (env: Record<string, string> = {}, log?: ReturnType<typeof capture>) => {
    const loaded = loadConfig({ WORKER_TOKEN, INTERNAL_API_TOKEN, LOG_LEVEL: log === undefined ? 'silent' : 'info', ...env });
    if (!loaded.ok) throw new Error(loaded.problems.join('; '));
    const store = createAnalysisStore(openDatabase(':memory:'), { maxWaiting: 10, leaseMs: 1000, maxAttempts: 2, failedRetryMs: 1000 });
    const resolve = vi.fn(async (name: string, versionOrTag: string) => {
        if (name === 'missing') throw new AppError('NOT_FOUND', `${name} is not on npm`);
        return versionOrTag === 'latest' ? '2.0.0' : versionOrTag;
    });
    const container: Container = {
        config: loaded.config,
        logger: createLogger(loaded.config, log?.stream),
        store,
        resolve,
        search: vi.fn(async () => []),
        listVersions: vi.fn(async () => [
            { version: '2.0.0', publishedAt: null },
            { version: '1.0.0', publishedAt: null },
        ]),
        readDownloads: vi.fn(async () => []),
        readStars: vi.fn(async () => 42),
        readMetadata: vi.fn(async () => ({ name: 'example', version: '1.0.0', deprecated: null, license: 'MIT', types: 'included' as const, typesPackage: null, installScripts: [] })),
    };
    return { app: createApp(container), store, resolve, readStars: container.readStars };
};

const worker = (body?: unknown): RequestInit => ({
    method: 'POST',
    headers: { authorization: `Bearer ${WORKER_TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
});

describe('the public API', () => {
    it('answers health without counting it', async () => {
        const { app } = setup({ RATE_LIMIT_PER_MINUTE: '1' });
        for (let i = 0; i < 3; i++) expect((await app.request('/v1/health')).status).toBe(200);
    });

    it('validates the package parameter', async () => {
        const { app } = setup();
        const response = await app.request('/v1/analyses?package=../etc');
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED', requestId: expect.any(String) } });
        expect((await app.request('/v1/analyses?package=react@^19')).status).toBe(400);
        expect((await app.request('/v1/history?package=react@1.0.0')).status).toBe(400);
        expect((await app.request('/v1/downloads?package=react&range=9y')).status).toBe(400);
        expect((await app.request('/v1/stars?repository=owner')).status).toBe(400);
        expect((await app.request('/v1/metadata?package=react')).status).toBe(400);
        expect((await app.request('/v1/search?q=a')).status).toBe(400);
    });

    it('queues a package once and serves its result, cacheable only when complete', async () => {
        const { app, store, resolve } = setup();
        const first = await app.request('/v1/analyses?package=example');
        expect(first.status).toBe(200);
        expect(first.headers.get('cache-control')).toBe('no-store');
        expect(await first.json()).toMatchObject({ status: 'queued', package: { name: 'example', version: '2.0.0' } });

        // The exact version is now known: polling it asks the registry nothing.
        resolve.mockClear();
        await app.request('/v1/analyses?package=example@2.0.0');
        expect(resolve).not.toHaveBeenCalled();

        store.complete(store.claim()?.id ?? 0, RESULT);
        const running = await app.request('/v1/analyses?package=example@2.0.0');
        expect(running.headers.get('cache-control')).toBe('no-store');
        expect(await running.json()).toMatchObject({ status: 'done', exports: { status: 'pending' } });

        store.failExports(1);
        const done = await app.request('/v1/analyses?package=example@2.0.0');
        expect(done.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=86400, stale-while-revalidate=86400');
        expect((await app.request('/v1/analyses?package=example')).headers.get('cache-control')).toBe('public, max-age=60, s-maxage=300, stale-while-revalidate=600');
        expect((await app.request('/v1/analyses?package=example@2.0.0&known=1')).headers.get('cache-control')).toBe('public, max-age=300, s-maxage=86400, stale-while-revalidate=86400');
        expect((await app.request('/v1/analyses?package=example&known=1')).headers.get('cache-control')).toBe('public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    });

    it('lets a CDN keep what changes slowly, and nothing that is in flight', async () => {
        const { app } = setup();
        const detail = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=3600';
        expect((await app.request('/v1/downloads?package=example&range=1y')).headers.get('cache-control')).toBe(detail);
        expect((await app.request('/v1/stars?repository=owner/example')).headers.get('cache-control')).toBe(detail);
        expect((await app.request('/v1/metadata?package=example@1.0.0')).headers.get('cache-control')).toBe(detail);
        expect((await app.request('/v1/packages')).headers.get('cache-control')).toBe(detail);
        expect((await app.request('/v1/search?q=react')).headers.get('cache-control')).toBe('public, max-age=60, s-maxage=300, stale-while-revalidate=600');
        expect((await app.request('/v1/history?package=example')).headers.get('cache-control')).toBe('no-store');
        expect((await app.request('/v1/health')).headers.get('cache-control')).toBe('no-store');
    });

    it('describes itself in OpenAPI, every path of which answers', async () => {
        const { app } = setup({ RATE_LIMIT_PER_MINUTE: '77' });
        const response = await app.request('/v1/openapi.json');
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toContain('max-age=3600');
        const document = (await response.json()) as { openapi: string; info: { description: string }; paths: Record<string, Record<string, unknown>> };
        expect(document.openapi).toBe('3.1.0');
        expect(document.info.description).toContain('77 requests per minute');
        for (const [path, operations] of Object.entries(document.paths)) {
            for (const method of Object.keys(operations)) {
                const answered = await app.request(`/v1${path}`, { method: method.toUpperCase() });
                expect(answered.status, `${method} ${path}`).toBeLessThan(500);
                expect(answered.status, `${method} ${path}`).not.toBe(404);
            }
        }
    });

    it('answers 304 to a caller that still has the answer, keeping the headers about the answer itself', async () => {
        const { app } = setup({ RATE_LIMIT_PER_MINUTE: '10' });
        const first = await app.request('/v1/search?q=react', { headers: { origin: 'http://localhost:3100' } });
        const tag = first.headers.get('etag');
        expect(tag).toMatch(/^"[0-9a-f]+"$/);
        const again = await app.request('/v1/search?q=react', { headers: { 'if-none-match': tag ?? '', origin: 'http://localhost:3100' } });
        expect(again.status).toBe(304);
        expect(await again.text()).toBe('');
        expect(again.headers.get('etag')).toBe(tag);
        expect(again.headers.get('cache-control')).toBe(first.headers.get('cache-control'));
        expect(again.headers.get('x-request-id')).toMatch(/\S/);
        expect(again.headers.get('ratelimit-remaining')).toBe('8');
        expect(again.headers.get('access-control-allow-origin')).toBe('http://localhost:3100');
        // Another answer is another tag, and a POST is never a 304.
        expect((await app.request('/v1/stars?repository=owner/example')).headers.get('etag')).not.toBe(tag);
        expect((await app.request('/v1/history?package=example', { method: 'POST', headers: { 'if-none-match': '*' } })).status).toBe(200);
    });

    it('reads only what is known for crawlers, and never queues for them', async () => {
        const { app, store } = setup();
        const missing = await app.request('/v1/analyses?package=example&known=1');
        expect(missing.status).toBe(404);
        expect(store.claim()).toBeUndefined();
        expect((await app.request('/v1/analyses?package=missing')).status).toBe(404);
    });

    it('queues the versions of a history for later, and lists them', async () => {
        const { app, store } = setup();
        const response = await app.request('/v1/history?package=example', { method: 'POST' });
        expect(response.status).toBe(200);
        expect((await response.json()) as { versions: { status: string }[] }).toMatchObject({
            versions: [
                { version: '2.0.0', status: 'queued' },
                { version: '1.0.0', status: 'queued' },
            ],
        });
        expect(store.claim()?.package.version).toBe('2.0.0');
    });

    it('answers 503 with Retry-After when the registry is silent', async () => {
        const { app, resolve } = setup();
        resolve.mockRejectedValueOnce(new AppError('UNAVAILABLE', 'The npm registry did not answer'));
        const response = await app.request('/v1/analyses?package=example');
        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBe('5');
    });

    it('keeps browsers from other sites out, and lets a local one in', async () => {
        const { app } = setup();
        const local = await app.request('/v1/search?q=react', { headers: { origin: 'http://localhost:3100' } });
        expect(local.headers.get('access-control-allow-origin')).toBe('http://localhost:3100');
        // A script on the page may read the request id and how much of its share is left.
        expect(local.headers.get('access-control-expose-headers')).toBe('X-Request-Id,Retry-After,RateLimit-Limit,RateLimit-Remaining,RateLimit-Reset');
        const other = await app.request('/v1/search?q=react', { headers: { origin: 'https://evil.example' } });
        expect(other.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('refuses a public body that is far too large before reading it, in the shape of the contract', async () => {
        const { app } = setup();
        const refused = await app.request('/v1/history?package=example', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(20_000) }) });
        expect(refused.status).toBe(400);
        expect(errorResponseSchema.parse(await refused.json()).error).toMatchObject({ code: 'VALIDATION_FAILED', requestId: expect.any(String) });
        // The id is set before the handlers run, so an answer given by a middleware carries it too.
        expect(refused.headers.get('x-request-id')).toMatch(/\S/);
        expect((await app.request('/v1/history?package=example', { method: 'POST', body: 'x'.repeat(1000) })).status).toBe(200);
        // The worker's results are larger: their own limit stands.
        expect((await app.request('/internal/jobs/claim', worker({ padding: 'x'.repeat(100_000) }))).status).toBe(200);
    });
});

describe('the error contract', () => {
    /** The API with two routes that fail the way a framework or a module would. */
    const failing = () => {
        const { app } = setup();
        app.get('/v1/framework/:status', (c) => {
            throw new HTTPException(Number(c.req.param('status')) as 400, { message: 'the framework said something internal' });
        });
        app.get('/v1/module/:kind', (c) => {
            if (c.req.param('kind') === 'details') throw new AppError('VALIDATION_FAILED', 'Two fields are wrong', [{ path: 'q', message: 'is required' }]);
            if (c.req.param('kind') === 'later') throw new AppError('UNAVAILABLE', 'The queue is full', undefined, 30);
            throw new Error('a bug');
        });
        return app;
    };

    it('answers a client error of the framework with a fixed message, never its own', async () => {
        const app = failing();
        const invalid = await app.request('/v1/framework/400');
        expect(invalid.status).toBe(400);
        const invalidText = await invalid.text();
        expect(invalidText).not.toContain('framework');
        expect(JSON.parse(invalidText)).toMatchObject({ error: { code: 'VALIDATION_FAILED', message: 'The request is not valid' } });
        const missing = await app.request('/v1/framework/404');
        expect(missing.status).toBe(404);
        const missingText = await missing.text();
        expect(missingText).not.toContain('framework');
        expect(JSON.parse(missingText)).toMatchObject({ error: { code: 'NOT_FOUND', message: 'There is nothing at this address' } });
        // A server error of the framework is a bug like any other.
        const broken = await app.request('/v1/framework/502');
        expect(broken.status).toBe(500);
        expect(await broken.json()).toMatchObject({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
    });

    it('carries field details and the retry time a module gives', async () => {
        const app = failing();
        const detailed = await app.request('/v1/module/details');
        expect(errorResponseSchema.parse(await detailed.json()).error.details).toEqual([{ path: 'q', message: 'is required' }]);
        const later = await app.request('/v1/module/later');
        expect(later.status).toBe(503);
        expect(later.headers.get('retry-after')).toBe('30');
        const bug = await app.request('/v1/module/bug');
        expect(bug.status).toBe(500);
        expect(JSON.stringify(await bug.json())).not.toContain('a bug');
    });

    it('logs each request with its route, duration and error code, and never a long path whole', async () => {
        const log = capture();
        const { app } = setup({}, log);
        await app.request('/v1/search?q=react');
        await app.request(`/v1/${'x'.repeat(1000)}`);
        const [ok, missing] = log.entries().filter((entry) => entry['msg'] === 'request');
        expect(ok).toMatchObject({ method: 'GET', path: '/v1/search', route: '/v1/search', status: 200, durationMs: expect.any(Number) });
        expect(ok).not.toHaveProperty('errorCode');
        expect(missing).toMatchObject({ status: 404, route: null, errorCode: 'NOT_FOUND', path: `/v1/${'x'.repeat(196)}` });
    });
});

describe('the rate limit', () => {
    it('gives each caller a share per minute, then answers 429 with Retry-After', async () => {
        const { app } = setup({ RATE_LIMIT_PER_MINUTE: '2' });
        const ask = (ip: string) => app.request('/v1/search?q=react', { headers: { 'x-real-ip': ip } });
        // Without a configured header the address in it means nothing: everyone is the connection, which tests do not have.
        expect((await ask('203.0.113.1')).headers.get('ratelimit-remaining')).toBe('1');
        expect((await ask('203.0.113.2')).headers.get('ratelimit-remaining')).toBe('0');
        const refused = await ask('203.0.113.3');
        expect(refused.status).toBe(429);
        expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
        expect(await refused.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    });

    it('counts callers by the proxy header when one is configured', async () => {
        const { app } = setup({ RATE_LIMIT_PER_MINUTE: '1', CLIENT_IP_HEADER: 'x-real-ip' });
        const ask = (ip: string) => app.request('/v1/search?q=react', { headers: { 'x-real-ip': ip } });
        expect((await ask('203.0.113.1')).status).toBe(200);
        expect((await ask('203.0.113.1')).status).toBe(429);
        expect((await ask('203.0.113.2')).status).toBe(200);
    });

    it('limits the frontend rendering per visitor it names, and its own documents together as one', async () => {
        const { app } = setup({ RATE_LIMIT_PER_MINUTE: '1', RATE_LIMIT_RENDER_PER_MINUTE: '2' });
        const render = (visitor?: string) => app.request('/v1/search?q=react', { headers: { 'x-internal-token': INTERNAL_API_TOKEN, ...(visitor === undefined ? {} : { 'x-visitor-ip': visitor }) } });
        expect((await render('203.0.113.1')).headers.get('ratelimit-limit')).toBe('2');
        expect((await render('203.0.113.1')).status).toBe(200);
        expect((await render('203.0.113.1')).status).toBe(429);
        expect((await render('203.0.113.2')).status).toBe(200);
        // No visitor named: a document for crawlers, or a rendering that lost sight of its visitors. The token alone is not
        // unlimited: all such requests share one render-sized count, blank and missing alike.
        expect((await render()).headers.get('ratelimit-limit')).toBe('2');
        expect((await render('  ')).status).toBe(200);
        expect((await render()).status).toBe(429);
        // Neither does that count touch a named visitor's own.
        expect((await render('203.0.113.3')).status).toBe(200);
        // A wrong token is any other caller.
        const stranger = await app.request('/v1/search?q=react', { headers: { 'x-internal-token': 'wrong', 'x-visitor-ip': '203.0.113.9' } });
        expect(stranger.headers.get('ratelimit-limit')).toBe('1');
    });

    it('gives queueing work a much smaller share', async () => {
        const { app } = setup({ RATE_LIMIT_QUEUE_PER_MINUTE: '1' });
        expect((await app.request('/v1/history?package=example', { method: 'POST' })).status).toBe(200);
        expect((await app.request('/v1/history?package=example', { method: 'POST' })).status).toBe(429);
        // Reading is not queueing.
        expect((await app.request('/v1/history?package=example')).status).toBe(200);
    });

    it('counts a package against that share when asking for its cost queues it, and never when it is known', async () => {
        const { app, store } = setup({ RATE_LIMIT_QUEUE_PER_MINUTE: '1' });
        expect((await app.request('/v1/analyses?package=example')).status).toBe(200);
        // Asking again, by tag or by version, queues nothing.
        for (const spec of ['example', 'example@2.0.0', 'example@2.0.0']) expect((await app.request(`/v1/analyses?package=${spec}`)).status).toBe(200);
        const refused = await app.request('/v1/analyses?package=another');
        expect(refused.status).toBe(429);
        expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
        expect(await refused.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
        // Nothing of it was queued: only the first package is there to take.
        expect(store.claim()?.package.name).toBe('example');
        expect(store.claim()).toBeUndefined();
    });

    it('asks GitHub only about the repository of a measured package', async () => {
        const { app, store, readStars } = setup();
        expect(await (await app.request('/v1/stars?repository=owner/example')).json()).toEqual({ stars: null });
        expect(readStars).not.toHaveBeenCalled();
        await app.request('/v1/analyses?package=example');
        store.complete(store.claim()?.id ?? 0, RESULT);
        expect(await (await app.request('/v1/stars?repository=owner/example')).json()).toEqual({ stars: 42 });
        expect(await (await app.request('/v1/stars?repository=owner/other')).json()).toEqual({ stars: null });
        expect(readStars).toHaveBeenCalledTimes(1);
    });
});

describe('the worker routes', () => {
    it('are not there for a request that came through the proxy, whatever token it carries', async () => {
        const { app } = setup({ CLIENT_IP_HEADER: 'cf-connecting-ip' });
        const init = worker();
        const proxied = await app.request('/internal/jobs/claim', { ...init, headers: { ...init.headers, 'cf-connecting-ip': '203.0.113.7' } });
        expect(proxied.status).toBe(404);
        expect((await app.request('/internal/jobs/claim', init)).status).toBe(200);
    });

    it('require the token, compared whole', async () => {
        const { app } = setup();
        expect((await app.request('/internal/jobs/claim', { method: 'POST' })).status).toBe(401);
        expect((await app.request('/internal/jobs/claim', { method: 'POST', headers: { authorization: `Bearer ${WORKER_TOKEN.slice(0, -1)}` } })).status).toBe(401);
        const claimed = await app.request('/internal/jobs/claim', worker());
        expect(claimed.status).toBe(200);
        expect(await claimed.json()).toEqual({ job: null });
    });

    it('take a job and its result, and refuse a body that is not the contract or not JSON', async () => {
        const { app } = setup();
        await app.request('/v1/analyses?package=example');
        const { job } = (await (await app.request('/internal/jobs/claim', worker())).json()) as { job: { id: number } };
        expect((await app.request(`/internal/jobs/${job.id}/result`, worker('{not json'))).status).toBe(400);
        expect((await app.request(`/internal/jobs/${job.id}/result`, worker({ sizes: null }))).status).toBe(400);
        expect((await app.request('/internal/jobs/abc/result', worker(RESULT))).status).toBe(400);
        const accepted = await app.request(`/internal/jobs/${job.id}/result`, worker(RESULT));
        expect(await accepted.json()).toEqual({ accepted: true });
        // A second answer to the same job is late.
        expect(await (await app.request(`/internal/jobs/${job.id}/result`, worker(RESULT))).json()).toEqual({ accepted: false });
    });

    it('are not rate limited and have no CORS', async () => {
        const { app } = setup({ RATE_LIMIT_PER_MINUTE: '1' });
        for (let i = 0; i < 3; i++) {
            const response = await app.request('/internal/jobs/claim', { ...worker(), headers: { ...worker().headers, origin: 'http://localhost:3100' } });
            expect(response.status).toBe(200);
            expect(response.headers.get('access-control-allow-origin')).toBeNull();
        }
    });
});

describe('the rate limit by address', () => {
    const headerSetup = (limit: number) => {
        const { app } = setup({ RATE_LIMIT_PER_MINUTE: String(limit), CLIENT_IP_HEADER: 'x-real-ip' });
        return (ip?: string) => app.request('/v1/search?q=react', { headers: ip === undefined ? {} : { 'x-real-ip': ip } });
    };

    it('counts an IPv4 caller down to zero, then refuses it until the window ends', async () => {
        const ask = headerSetup(3);
        for (const remaining of ['2', '1', '0']) {
            const response = await ask('203.0.113.7');
            expect(response.status).toBe(200);
            expect(response.headers.get('ratelimit-limit')).toBe('3');
            expect(response.headers.get('ratelimit-remaining')).toBe(remaining);
            expect(Number(response.headers.get('ratelimit-reset'))).toBeGreaterThan(0);
            expect(Number(response.headers.get('ratelimit-reset'))).toBeLessThanOrEqual(60);
        }
        const refused = await ask('203.0.113.7');
        expect(refused.status).toBe(429);
        expect(refused.headers.get('ratelimit-remaining')).toBe('0');
        expect(Number(refused.headers.get('retry-after'))).toBe(Number(refused.headers.get('ratelimit-reset')));
        // The neighbour is another caller.
        expect((await ask('203.0.113.8')).status).toBe(200);
    });

    it('counts every address of one IPv6 /64 as one caller, however it is spelled', async () => {
        const ask = headerSetup(2);
        expect((await ask('2001:db8:1:2::1')).status).toBe(200);
        expect((await ask('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).headers.get('ratelimit-remaining')).toBe('0');
        expect((await ask('2001:db8:1:2:dead:beef::1')).status).toBe(429);
        // The next block over is someone else, as is an address one bit off in the prefix.
        expect((await ask('2001:db8:1:3::1')).status).toBe(200);
        expect((await ask('2001:db8:1:2::1%en0')).status).toBe(429);
    });

    it('counts an IPv4 address as the same caller whether or not it comes mapped into IPv6', async () => {
        const ask = headerSetup(2);
        expect((await ask('203.0.113.7')).status).toBe(200);
        expect((await ask('::ffff:203.0.113.7')).headers.get('ratelimit-remaining')).toBe('0');
        expect((await ask('::FFFF:203.0.113.7')).status).toBe(429);
        expect((await ask('203.0.113.9')).status).toBe(200);
    });

    it('does not take a header at its word unless it is exactly one address', async () => {
        const ask = headerSetup(1);
        // Each of these falls back to the connection, which `app.request` has none of: they all share one count.
        expect((await ask('203.0.113.7, 10.0.0.1')).status).toBe(200);
        expect((await ask('evil.example')).status).toBe(429);
        expect((await ask('2001:db8::1, 2001:db8::2')).status).toBe(429);
        expect((await ask()).status).toBe(429);
        // A real address still has its own count.
        expect((await ask('203.0.113.7')).status).toBe(200);
    });

    it('refuses a chain header as the configured one', () => {
        for (const header of ['x-forwarded-for', 'X-Forwarded-For', 'forwarded']) {
            const loaded = loadConfig({ WORKER_TOKEN, INTERNAL_API_TOKEN, LOG_LEVEL: 'silent', CLIENT_IP_HEADER: header });
            expect(loaded.ok).toBe(false);
        }
    });
});

describe('the rate limit on a real socket', () => {
    /** The API listening on every address of this machine, so that IPv4 and IPv6 loopback both reach it. */
    const listen = async (env: Record<string, string>) => {
        const { app } = setup(env);
        const server = serve({ fetch: app.fetch, hostname: '::', port: 0 });
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('no port');
        const ask = (host: string, headers: Record<string, string> = {}) => fetch(`http://${host}:${address.port}/v1/search?q=react`, { headers });
        const close = () => new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
        return { ask, close };
    };

    it('counts the IPv4 and the IPv6 loopback as two callers, from the connection alone', async () => {
        const { ask, close } = await listen({ RATE_LIMIT_PER_MINUTE: '2' });
        try {
            expect((await ask('127.0.0.1')).headers.get('ratelimit-remaining')).toBe('1');
            expect((await ask('127.0.0.1')).headers.get('ratelimit-remaining')).toBe('0');
            expect((await ask('127.0.0.1')).status).toBe(429);
            expect((await ask('[::1]')).status).toBe(200);
            expect((await ask('[::1]')).headers.get('ratelimit-remaining')).toBe('0');
            expect((await ask('[::1]')).status).toBe(429);
        } finally {
            await close();
        }
    });

    it('sees an IPv4 connection on a dual-stack socket as its IPv4 address, not as a mapped IPv6 one', async () => {
        const { ask, close } = await listen({ RATE_LIMIT_PER_MINUTE: '2', CLIENT_IP_HEADER: 'x-real-ip' });
        try {
            // On a socket bound to `::`, an IPv4 peer arrives as `::ffff:127.0.0.1`. The header names the plain address: one caller.
            expect((await ask('127.0.0.1')).status).toBe(200);
            expect((await ask('127.0.0.1', { 'x-real-ip': '127.0.0.1' })).headers.get('ratelimit-remaining')).toBe('0');
            expect((await ask('127.0.0.1')).status).toBe(429);
            // A header a proxy did not write is still not believed when it is no address.
            expect((await ask('127.0.0.1', { 'x-real-ip': 'not-an-ip' })).status).toBe(429);
        } finally {
            await close();
        }
    });

    it('ignores a chain header on the connection, even one naming a fresh address each time', async () => {
        const { ask, close } = await listen({ RATE_LIMIT_PER_MINUTE: '1' });
        try {
            expect((await ask('127.0.0.1', { 'x-forwarded-for': '198.51.100.1' })).status).toBe(200);
            expect((await ask('127.0.0.1', { 'x-forwarded-for': '198.51.100.2' })).status).toBe(429);
            expect((await ask('127.0.0.1', { 'x-real-ip': '198.51.100.3' })).status).toBe(429);
        } finally {
            await close();
        }
    });
});

describe('the typed client from core, against this API', () => {
    const clientOf = (app: ReturnType<typeof setup>['app']) => createApiClient({ baseUrl: 'http://api.test', fetch: (input, init) => Promise.resolve(app.request(String(input), init)) });

    it('reads every answer through the contract', async () => {
        const { app, store } = setup();
        const client = clientOf(app);
        expect(await client.knownAnalysis('example')).toBeUndefined();
        expect(await client.analysis('example')).toMatchObject({ status: 'queued', package: { name: 'example', version: '2.0.0' } });
        const job = store.claim();
        if (job === undefined) throw new Error('nothing was queued');
        store.complete(job.id, RESULT);
        expect(await client.knownAnalysis('example')).toMatchObject({ status: 'done', result: { sizes: { gzip: 200 } } });
        expect((await client.history('example')).versions.map((entry) => entry.version)).toEqual(['2.0.0', '1.0.0']);
        expect((await client.measureHistory('example')).name).toBe('example');
        expect((await client.downloads('example', '1y')).days).toEqual([]);
        expect((await client.metadata('example', '1.0.0')).license).toBe('MIT');
        expect(await client.stars('owner/example')).toBe(42);
        expect(await client.search('example')).toEqual([]);
        expect(await client.packages()).toMatchObject([{ name: 'example' }]);
    });

    it('turns what the API refuses into its error', async () => {
        const { app } = setup();
        await expect(clientOf(app).analysis('missing')).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'missing is not on npm' });
    });
});
