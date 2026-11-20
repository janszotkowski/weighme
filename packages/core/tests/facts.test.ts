import { describe, expect, it } from 'vitest';
import { analysisFacts, isMadeForNode, type AnalysisResult } from '@src/index.ts';

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

const base = { package: { name: 'example', version: '1.0.0' }, analyzerVersion: 1 };

describe('what an analysis says to a reader', () => {
    it.each(['queued', 'running'] as const)('is being measured while it is %s', (status) => {
        expect(analysisFacts({ ...base, status })).toEqual({ state: 'measuring' });
    });

    it('has failed, with the failure', () => {
        const failure = { code: 'TIMEOUT' as const, message: 'Too slow' };
        expect(analysisFacts({ ...base, status: 'failed', failure })).toEqual({ state: 'failed', failure });
    });

    it('is measured with its sizes, whether or not the part-by-part numbers have arrived', () => {
        expect(analysisFacts({ ...base, status: 'done', result: RESULT, exports: { status: 'pending' } })).toEqual({
            state: 'measured',
            result: RESULT,
            exports: { status: 'pending' },
            sizes: RESULT.sizes,
            madeForNode: false,
        });
    });

    it('has nothing to import when there is no bundle', () => {
        const result = { ...RESULT, sizes: null, entry: null };
        expect(analysisFacts({ ...base, status: 'done', result, exports: { status: 'unavailable' } })).toEqual({
            state: 'nothing-to-import',
            result,
            exports: { status: 'unavailable' },
            madeForNode: false,
        });
    });

    it.each([
        [{ nodeBuiltins: ['fs'], nativeAddons: 0, unresolvedImports: 0 }, true],
        [{ nodeBuiltins: [], nativeAddons: 1, unresolvedImports: 0 }, true],
        // An import that could not be found says the number may be too small, not where the package runs.
        [{ nodeBuiltins: [], nativeAddons: 0, unresolvedImports: 3 }, false],
    ])('is made for Node.js when it needs what a browser does not have', (environment, expected) => {
        expect(isMadeForNode(environment)).toBe(expected);
        expect(analysisFacts({ ...base, status: 'done', result: { ...RESULT, environment }, exports: { status: 'pending' } })).toMatchObject({ madeForNode: expected });
    });
});
