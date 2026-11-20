import { describe, expect, it } from 'vitest';
import { askAgain, measuringCount, specToAsk, type AnalysisResponse, type AnalysisResult } from '@src/index.ts';

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

const base = { package: { name: '@scope/example', version: '1.2.3' }, analyzerVersion: 1 };
const done = (exports: Extract<AnalysisResponse, { status: 'done' }>['exports']): AnalysisResponse => ({ ...base, status: 'done', result: RESULT, exports });

describe('following an analysis', () => {
    it('asks with what was typed first, then only for the exact version the answer named', () => {
        expect(specToAsk('@scope/example@next', undefined)).toBe('@scope/example@next');
        expect(specToAsk('@scope/example@next', { ...base, status: 'queued' })).toBe('@scope/example@1.2.3');
    });

    it.each(['queued', 'running'] as const)('asks again soon for the sizes while it is %s', (status) => {
        expect(askAgain({ ...base, status })).toEqual({ awaiting: 'sizes', afterMs: 1000 });
    });

    it('asks again, less often, while only the part-by-part numbers are awaited', () => {
        expect(askAgain(done({ status: 'pending' }))).toEqual({ awaiting: 'parts', afterMs: 2000 });
    });

    it('stops once nothing more will come', () => {
        expect(askAgain(done({ status: 'unavailable' }))).toBeUndefined();
        expect(askAgain({ ...base, status: 'failed', failure: { code: 'TIMEOUT', message: 'Too slow' } })).toBeUndefined();
    });
});

describe('a history being measured', () => {
    it('counts the versions queued or running, not the ones nobody asked for', () => {
        const entry = (status: 'unmeasured' | 'queued' | 'running' | 'done' | 'failed') => ({ version: '1.0.0', publishedAt: null, status, gzip: null, minified: null });
        expect(measuringCount({ name: 'example', versions: [entry('queued'), entry('running'), entry('unmeasured'), entry('done'), entry('failed')] })).toBe(2);
        expect(measuringCount({ name: 'example', versions: [entry('done')] })).toBe(0);
    });
});
