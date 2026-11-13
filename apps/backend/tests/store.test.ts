import { describe, expect, it } from 'vitest';
import { ANALYZER_VERSION, type AnalysisResult, type ExportDetails } from '@weighme/core';
import { openDatabase } from '@modules/analyses/infrastructure/database.ts';
import { createAnalysisStore } from '@modules/analyses/infrastructure/store.ts';

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

const DETAILS: ExportDetails = {
    format: 'esm',
    sideEffectsFree: true,
    named: [{ name: 'add', minified: 80, gzip: 60 }],
    namedTotal: 1,
    namedFailed: 0,
    subpaths: [{ path: './client', minified: 40, gzip: 30 }],
    subpathsTotal: 1,
    subpathsFailed: 0,
    subpathPatterns: 0,
};

const REF = { name: 'example', version: '1.0.0' };

const setup = (maxWaiting = 10) => {
    const clock = { now: 1000 };
    const store = createAnalysisStore(openDatabase(':memory:'), { maxWaiting, leaseMs: 100, maxAttempts: 2, failedRetryMs: 500, now: () => clock.now });
    return { clock, store };
};

describe('analysis store', () => {
    it('queues a package once, however often it is asked for', () => {
        const { store } = setup();
        expect(store.findOrEnqueue(REF).status).toBe('queued');
        expect(store.findOrEnqueue(REF).status).toBe('queued');
        expect(store.claim()?.package).toEqual(REF);
        expect(store.claim()).toBeUndefined();
    });

    it('serves a finished result', () => {
        const { store } = setup();
        store.findOrEnqueue(REF);
        const job = store.claim();
        expect(store.findOrEnqueue(REF).status).toBe('running');
        expect(store.complete(job?.id ?? 0, RESULT)).toBe(true);
        expect(store.find(REF)).toMatchObject({ status: 'done', result: RESULT });
    });

    it('awaits the part-by-part numbers after the result, then serves them', () => {
        const { store } = setup();
        store.findOrEnqueue(REF);
        const id = store.claim()?.id ?? 0;
        store.complete(id, RESULT);
        expect(store.find(REF)).toMatchObject({ status: 'done', exports: { status: 'pending' } });
        expect(store.completeExports(id, DETAILS)).toBe(true);
        expect(store.find(REF)).toMatchObject({ status: 'done', result: RESULT, exports: { status: 'done', details: DETAILS } });
    });

    it('keeps the result when the part-by-part numbers fail', () => {
        const { store } = setup();
        store.findOrEnqueue(REF);
        const id = store.claim()?.id ?? 0;
        store.complete(id, RESULT);
        expect(store.failExports(id)).toBe(true);
        expect(store.find(REF)).toMatchObject({ status: 'done', result: RESULT, exports: { status: 'unavailable' } });
    });

    it('stops waiting for the numbers of a worker that went silent', () => {
        const { clock, store } = setup();
        store.findOrEnqueue(REF);
        store.complete(store.claim()?.id ?? 0, RESULT);
        clock.now += 100;
        expect(store.find(REF)).toMatchObject({ status: 'done', exports: { status: 'unavailable' } });
    });

    it('measures what someone is waiting for before what was queued for later', () => {
        const { store } = setup();
        store.enqueueLater([{ name: 'later', version: '1.0.0' }]);
        store.findOrEnqueue(REF);
        expect(store.claim()?.package).toEqual(REF);
        expect(store.claim()?.package.name).toBe('later');
    });

    it('moves a package up when someone starts waiting for it', () => {
        const { store } = setup();
        store.enqueueLater([{ name: 'later', version: '1.0.0' }]);
        store.enqueueLater([REF]);
        store.findOrEnqueue(REF);
        expect(store.claim()?.package).toEqual(REF);
    });

    it('leaves alone what is already known when queueing for later', () => {
        const { store } = setup();
        store.findOrEnqueue(REF);
        store.complete(store.claim()?.id ?? 0, RESULT);
        store.enqueueLater([REF]);
        expect(store.find(REF)?.status).toBe('done');
        expect(store.claim()).toBeUndefined();
    });

    it('lists only what has been measured', () => {
        const { store } = setup();
        store.findOrEnqueue(REF);
        store.findOrEnqueue({ name: 'waiting', version: '1.0.0' });
        store.complete(store.claim()?.id ?? 0, RESULT);
        expect(store.measuredPackages(10).map((entry) => entry.name)).toEqual(['example']);
    });

    it('takes a job from a silent worker, then gives up after its attempts', () => {
        const { clock, store } = setup();
        store.findOrEnqueue(REF);
        const first = store.claim();
        clock.now += 101;
        const second = store.claim();
        expect(second?.id).toBe(first?.id);
        clock.now += 101;
        expect(store.claim()).toBeUndefined();
        expect(store.find(REF)).toMatchObject({ status: 'failed', failure: { code: 'TIMEOUT' } });
    });

    it('drops the late answer of a worker that lost its job', () => {
        const { clock, store } = setup();
        store.findOrEnqueue(REF);
        const job = store.claim();
        clock.now += 101;
        store.claim();
        clock.now += 101;
        store.claim();
        expect(store.complete(job?.id ?? 0, RESULT)).toBe(false);
    });

    it('tries a failed package again only after a while', () => {
        const { clock, store } = setup();
        store.findOrEnqueue(REF);
        store.fail(store.claim()?.id ?? 0, { code: 'BUNDLE_FAILED', message: 'no' });
        expect(store.findOrEnqueue(REF).status).toBe('failed');
        clock.now += 500;
        expect(store.findOrEnqueue(REF).status).toBe('queued');
    });

    it('answers the status and sizes of every known version of a package at once', () => {
        const { store } = setup();
        store.findOrEnqueue(REF);
        store.complete(store.claim()?.id ?? 0, RESULT);
        store.findOrEnqueue({ name: 'example', version: '2.0.0' });
        store.findOrEnqueue({ name: 'other', version: '1.0.0' });
        expect([...store.summaries('example')]).toEqual([
            ['1.0.0', { status: 'done', gzip: 200, minified: 300 }],
            ['2.0.0', { status: 'queued', gzip: null, minified: null }],
        ]);
    });

    it('knows the repository of a measured package, in a folder of it too, and no other', () => {
        const { store } = setup();
        store.findOrEnqueue(REF);
        store.complete(store.claim()?.id ?? 0, RESULT);
        store.findOrEnqueue({ name: 'nested', version: '1.0.0' });
        store.complete(store.claim()?.id ?? 0, { ...RESULT, repositoryUrl: 'https://github.com/owner/mono/tree/HEAD/packages/nested' });
        expect(store.knowsRepository('owner/example')).toBe(true);
        expect(store.knowsRepository('owner/mono')).toBe(true);
        for (const other of ['owner/exampl', 'owner/example-2', 'owner/example.js', 'owner/mon', 'other/example']) expect(store.knowsRepository(other), other).toBe(false);
    });

    it('keeps the list of measured packages for a few minutes', () => {
        const { clock, store } = setup();
        store.findOrEnqueue(REF);
        store.complete(store.claim()?.id ?? 0, RESULT);
        expect(store.measuredPackages(10)).toHaveLength(1);
        store.findOrEnqueue({ name: 'second', version: '1.0.0' });
        store.complete(store.claim()?.id ?? 0, RESULT);
        expect(store.measuredPackages(10)).toHaveLength(1);
        clock.now += 5 * 60_000;
        expect(store.measuredPackages(10)).toHaveLength(2);
    });

    it('counts what it adds to the queue, and nothing for what is known', () => {
        const { clock, store } = setup();
        let counted = 0;
        const count = (): void => void counted++;
        store.findOrEnqueue(REF, count);
        store.findOrEnqueue(REF, count);
        expect(counted).toBe(1);
        store.fail(store.claim()?.id ?? 0, { code: 'BUNDLE_FAILED', message: 'no' });
        store.findOrEnqueue(REF, count);
        expect(counted).toBe(1);
        clock.now += 500;
        store.findOrEnqueue(REF, count);
        expect(counted).toBe(2);
        // A refusal queues nothing.
        const refuse = (): void => {
            throw new Error('not now');
        };
        expect(() => store.findOrEnqueue({ name: 'other', version: '1.0.0' }, refuse)).toThrow('not now');
        expect(store.find({ name: 'other', version: '1.0.0' })).toBeUndefined();
    });

    it('gives what an older way of measuring left waiting none of the room, and removes it', () => {
        const db = openDatabase(':memory:');
        const store = createAnalysisStore(db, { maxWaiting: 1, leaseMs: 100, maxAttempts: 2, failedRetryMs: 500 });
        const old = db.prepare("INSERT INTO analyses (name, version, analyzer_version, status, requested_at, priority) VALUES (?, '1.0.0', ?, 'queued', 0, ?)");
        old.run('old-waiting', ANALYZER_VERSION - 1, 0);
        old.run('old-later', ANALYZER_VERSION - 1, 1);
        old.run('newer', ANALYZER_VERSION + 1, 0);
        // The line of this way of measuring is empty, whatever the old one left in it.
        expect(store.findOrEnqueue(REF).status).toBe('queued');
        expect(() => store.enqueueLater([{ name: 'later', version: '1.0.0' }])).not.toThrow();
        expect(store.forgetOutdated()).toBe(2);
        expect(store.forgetOutdated()).toBe(0);
        // A newer build's rows stay: going back a build loses nothing.
        expect((db.prepare('SELECT count(*) AS n FROM analyses').get() as { n: number }).n).toBe(3);
    });

    it('refuses new work when too much is waiting', () => {
        const { store } = setup(1);
        store.findOrEnqueue(REF);
        expect(() => store.findOrEnqueue({ name: 'other', version: '1.0.0' })).toThrow('waiting');
    });
});
