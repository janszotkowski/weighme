import type { AnalysisResult, ExportDetails, Job } from '@weighme/core';
import { describe, expect, it, vi } from 'vitest';
import type { AnalyzeMessage } from '@modules/analysis/protocol.ts';
import { createJobLoop, type JobLoopDeps } from '@modules/jobs/loop.ts';

const RESULT: AnalysisResult = {
    bundler: { name: 'rolldown', version: '1.0.0' },
    entry: 'export-star',
    commands: [],
    composition: { packages: [], total: 0 },
    sizes: { minified: 300, gzip: 200, brotli: 100 },
    install: { bytes: 1000, packages: 1 },
    peerDependencies: [],
    description: null,
    environment: { nodeBuiltins: [], nativeAddons: 0, unresolvedImports: 0 },
    repositoryUrl: null,
    timingsMs: { install: 1, bundle: 1, compress: 1 },
};

const DETAILS: ExportDetails = { format: 'esm', sideEffectsFree: true, named: [], namedTotal: 0, namedFailed: 0, subpaths: [], subpathsTotal: 0, subpathsFailed: 0, subpathPatterns: 0 };

const FAILURE = { code: 'INSTALL_FAILED' as const, message: 'No such package' };

const job = (id: number): Job => ({ id, package: { name: `example-${id}`, version: '1.0.0' } });

type Setup = {
    /** What each claim answers, in order; an error is thrown, and past the end the queue is empty. */
    claims?: (Job | Error)[];
    /** What the analysis of a job says. */
    says?: (ref: Job['package']) => AnalyzeMessage[];
    /** Holds an analysis back until the test lets it go. */
    gate?: (ref: Job['package']) => Promise<void>;
    accepted?: boolean;
    storeBytes?: number;
    concurrency?: number;
    /** The loop is stopped at the first wait for which this holds. */
    stopWhen?: (sleeps: number[]) => boolean;
};

const setup = (options: Setup = {}) => {
    const claims = [...(options.claims ?? [])];
    const calls: string[] = [];
    const sleeps: number[] = [];
    const stop = new AbortController();
    const backend: JobLoopDeps['backend'] = {
        claim: async () => {
            const next = claims.shift();
            if (next instanceof Error) throw next;
            return next;
        },
        complete: async (id) => {
            calls.push(`result ${id}`);
            return options.accepted ?? true;
        },
        fail: async (id) => {
            calls.push(`failure ${id}`);
            return true;
        },
        completeExports: async (id) => {
            calls.push(`exports ${id}`);
            return true;
        },
        failExports: async (id) => {
            calls.push(`exports-failure ${id}`);
            return true;
        },
    };
    const store = { bytes: vi.fn(async () => options.storeBytes ?? 0), empty: vi.fn(async () => undefined) };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const loop = createJobLoop({
        backend,
        analyze: async (ref, onMessage) => {
            for (const message of options.says?.(ref) ?? [
                { kind: 'result', result: RESULT },
                { kind: 'exports', exports: DETAILS },
            ])
                await onMessage(message);
            await options.gate?.(ref);
        },
        store,
        sleep: async (ms) => {
            sleeps.push(ms);
            if ((options.stopWhen ?? (() => true))(sleeps)) stop.abort();
            // Lets the other slots run instead of spinning in this one.
            else await new Promise((resolve) => setImmediate(resolve));
        },
        now: () => 0,
        logger,
        limits: { WORKER_CONCURRENCY: options.concurrency ?? 1, WORKER_POLL_MS: 1000, STORE_MAX_BYTES: 10_000_000 },
    });
    const logged = (level: 'info' | 'warn'): unknown[] => logger[level].mock.calls.map((call) => call[1]);
    return { calls, sleeps, store, logged, run: () => loop.run(stop.signal) };
};

describe('the job loop', () => {
    it('hands in what each analysis says, in order, then waits for work', async () => {
        const { calls, sleeps, run } = setup({ claims: [job(1), job(2)] });
        await run();
        expect(calls).toEqual(['result 1', 'exports 1', 'result 2', 'exports 2']);
        expect(sleeps).toEqual([1000]);
    });

    it('says when the backend had given the job away', async () => {
        const { logged, run } = setup({ claims: [job(1)], accepted: false });
        await run();
        expect(logged('warn')).toContain('analyzed too late: the backend had given the job away');
    });

    it('hands in a failure and the missing part-by-part numbers', async () => {
        const { calls, run } = setup({
            claims: [job(1), job(2)],
            says: (ref) => (ref.name === 'example-1' ? [{ kind: 'failure', failure: FAILURE }] : [{ kind: 'result', result: RESULT }, { kind: 'exports-failure' }]),
        });
        await run();
        expect(calls).toEqual(['failure 1', 'result 2', 'exports-failure 2']);
    });

    it('asks less often the longer the backend stays away, and says so once', async () => {
        const away = new Error('connect ECONNREFUSED');
        const { sleeps, logged, run } = setup({ claims: [away, away, away], stopWhen: (waits) => waits.length === 4 });
        await run();
        expect(sleeps).toEqual([1000, 2000, 4000, 1000]);
        expect(logged('warn')).toEqual(['worker loop']);
        expect(logged('info')).toContain('backend reachable again');
    });

    it('weighs the store at the start, and not again after a small install', async () => {
        const { store, run } = setup({ claims: [job(1)] });
        await run();
        expect(store.bytes).toHaveBeenCalledTimes(1);
    });

    it('weighs the store after a failure, which says nothing of what it left there', async () => {
        const { store, run } = setup({ claims: [job(1)], says: () => [{ kind: 'failure', failure: FAILURE }] });
        await run();
        expect(store.bytes).toHaveBeenCalledTimes(2);
        expect(store.empty).not.toHaveBeenCalled();
    });

    it('empties a store past its limit', async () => {
        const { store, logged, run } = setup({ storeBytes: 10_000_001 });
        await run();
        expect(store.empty).toHaveBeenCalledTimes(1);
        expect(logged('info')).toContain('store emptied');
    });

    it('leaves the store alone while a job is in flight', async () => {
        const release = new Map<string, () => void>();
        const { store, run } = setup({
            claims: [job(1), job(2)],
            concurrency: 2,
            says: () => [{ kind: 'failure', failure: FAILURE }],
            gate: (ref) =>
                new Promise((resolve) => {
                    release.set(ref.name, resolve);
                }),
            stopWhen: () => release.size === 0,
        });
        const running = run();
        await vi.waitFor(() => expect(release.size).toBe(2));
        release.get('example-1')?.();
        release.delete('example-1');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(store.bytes).toHaveBeenCalledTimes(1);
        release.get('example-2')?.();
        release.delete('example-2');
        await running;
        expect(store.bytes).toHaveBeenCalledTimes(2);
    });
});
