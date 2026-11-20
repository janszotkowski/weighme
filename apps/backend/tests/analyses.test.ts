import { describe, expect, it, vi } from 'vitest';
import type { AnalysisResult } from '@weighme/core';
import { createAnalyses } from '@modules/analyses/application/analyses.ts';
import { openDatabase } from '@modules/analyses/infrastructure/database.ts';
import { createAnalysisStore } from '@modules/analyses/infrastructure/store.ts';
import { AppError } from '@platform/errors.ts';

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

const free = (): void => undefined;

/** The use cases over an in-memory store, with the registry and GitHub stood in for. */
const setup = () => {
    const clock = { now: 1000 };
    const store = createAnalysisStore(openDatabase(':memory:'), { maxWaiting: 10, leaseMs: 100, maxAttempts: 2, failedRetryMs: 500, now: () => clock.now });
    const resolve = vi.fn(async (_name: string, versionOrTag: string) => (versionOrTag === 'latest' ? '2.0.0' : versionOrTag));
    const readStars = vi.fn(async () => 42);
    const readMetadata = vi.fn(async (name: string, version: string) => ({ name, version, deprecated: null, license: 'MIT', types: 'included' as const, typesPackage: null, installScripts: [] }));
    const listVersions = vi.fn(async () => [
        { version: '2.0.0', publishedAt: null },
        { version: '1.0.0', publishedAt: null },
    ]);
    const analyses = createAnalyses({ store, resolve, listVersions, readStars, readMetadata });
    /** Has the worker's side of the store measure whatever waits next. */
    const measure = (): void => {
        store.complete(store.claim()?.id ?? 0, RESULT);
    };
    return { clock, store, resolve, readStars, readMetadata, analyses, measure };
};

describe('asking for an analysis', () => {
    it('queues what a tag stands for, and counts it against the share of whoever asked', async () => {
        const { analyses, resolve } = setup();
        const share = vi.fn();
        const answer = await analyses.lookUp({ name: 'example', version: undefined }, share);
        expect(answer).toMatchObject({ exact: false, analysis: { status: 'queued', package: { name: 'example', version: '2.0.0' } } });
        expect(resolve).toHaveBeenCalledWith('example', 'latest');
        expect(share).toHaveBeenCalledTimes(1);
    });

    it('asks neither the registry nor the share about an exact version it knows', async () => {
        const { analyses, resolve } = setup();
        await analyses.lookUp({ name: 'example', version: '1.0.0' }, free);
        resolve.mockClear();
        const share = vi.fn();
        expect(await analyses.lookUp({ name: 'example', version: '1.0.0' }, share)).toMatchObject({ exact: true, analysis: { status: 'queued' } });
        expect(resolve).not.toHaveBeenCalled();
        expect(share).not.toHaveBeenCalled();
    });

    it('queues nothing when the share refuses', async () => {
        const { analyses, store } = setup();
        const refuse = (): void => {
            throw new AppError('RATE_LIMITED', 'Too many');
        };
        await expect(analyses.lookUp({ name: 'example', version: '1.0.0' }, refuse)).rejects.toThrow('Too many');
        expect(store.find({ name: 'example', version: '1.0.0' })).toBeUndefined();
    });

    it('asks the registry again about a version that failed, before it is queued once more', async () => {
        const { analyses, clock, store, resolve } = setup();
        await analyses.lookUp({ name: 'example', version: '1.0.0' }, free);
        store.fail(store.claim()?.id ?? 0, { code: 'INSTALL_FAILED', message: 'No such version' });
        resolve.mockClear();
        clock.now += 500;
        expect((await analyses.lookUp({ name: 'example', version: '1.0.0' }, free)).analysis.status).toBe('queued');
        expect(resolve).toHaveBeenCalledWith('example', '1.0.0');
    });
});

describe('reading what has been measured', () => {
    it('never queues: what is not known is not found', async () => {
        const { analyses, store } = setup();
        await expect(analyses.known({ name: 'example', version: undefined })).rejects.toThrow('example@2.0.0 has not been measured');
        expect(store.claim()).toBeUndefined();
    });

    it('serves what is known, and says whether an exact version was asked for', async () => {
        const { analyses, measure } = setup();
        await analyses.lookUp({ name: 'example', version: '2.0.0' }, free);
        measure();
        expect(await analyses.known({ name: 'example', version: undefined })).toMatchObject({ exact: false, analysis: { status: 'done' } });
        expect(await analyses.known({ name: 'example', version: '2.0.0' })).toMatchObject({ exact: true, analysis: { status: 'done' } });
    });
});

describe("a package's history", () => {
    it('shows each release with where its measurement stands, and queues nothing', async () => {
        const { analyses, store, measure } = setup();
        await analyses.lookUp({ name: 'example', version: '2.0.0' }, free);
        measure();
        expect(await analyses.history('example')).toEqual({
            name: 'example',
            versions: [
                { version: '2.0.0', publishedAt: null, status: 'done', gzip: 200, minified: 300 },
                { version: '1.0.0', publishedAt: null, status: 'unmeasured', gzip: null, minified: null },
            ],
        });
        expect(store.claim()).toBeUndefined();
    });

    it('queues every release when it is asked to be measured', async () => {
        const { analyses } = setup();
        expect((await analyses.measureHistory('example')).versions.map((entry) => entry.status)).toEqual(['queued', 'queued']);
    });
});

describe('what is passed on from outside', () => {
    it('asks GitHub only about a repository a measured package names', async () => {
        const { analyses, readStars, measure } = setup();
        expect(await analyses.stars('owner/example')).toBeNull();
        expect(readStars).not.toHaveBeenCalled();
        await analyses.lookUp({ name: 'example', version: '2.0.0' }, free);
        measure();
        expect(await analyses.stars('owner/example')).toBe(42);
    });

    it('reads the metadata of the version a tag stands for', async () => {
        const { analyses, readMetadata } = setup();
        await analyses.metadata({ name: 'example', version: undefined });
        expect(readMetadata).toHaveBeenCalledWith('example', '2.0.0');
    });
});
