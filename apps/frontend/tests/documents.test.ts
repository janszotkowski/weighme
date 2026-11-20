import type { AnalysisResponse } from '@weighme/core';
import { describe, expect, it, vi } from 'vitest';
import { createDocuments, type DocumentDeps } from '@lib/documents/router';

const DONE: AnalysisResponse = {
    status: 'done',
    package: { name: 'react', version: '19.1.0' },
    analyzerVersion: 1,
    exports: { status: 'unavailable' },
    result: {
        bundler: { name: 'rolldown', version: '1.0.0' },
        entry: 'export-star',
        commands: [],
        composition: { packages: [], total: 0 },
        sizes: { minified: 7500, gzip: 2900, brotli: 2600 },
        install: { bytes: 1000, packages: 1 },
        peerDependencies: [],
        description: null,
        environment: { nodeBuiltins: [], nativeAddons: 0, unresolvedImports: 0 },
        repositoryUrl: null,
        timingsMs: { install: 1, bundle: 1, compress: 1 },
    },
};

/** The documents with the API and the drawing stood in for; each test gets its own, with nothing kept from another. */
const setup = (deps: Partial<DocumentDeps> = {}) => {
    const all = {
        knownAnalysis: vi.fn(async (): Promise<AnalysisResponse | undefined> => DONE),
        measuredPackages: vi.fn(async () => [{ name: 'react', measuredAt: '2026-11-04T00:00:00.000Z' }]),
        drawDefaultImage: vi.fn(async () => new Uint8Array([1])),
        drawPackageImage: vi.fn(async () => new Uint8Array([2])),
        visitor: (): string | undefined => '203.0.113.1',
        ...deps,
    };
    const documents = createDocuments(all);
    const get = async (path: string, headers: Record<string, string> = {}): Promise<Response | undefined> => documents(new Request(`http://localhost:3100${path}`, { headers }), path);
    return { ...all, get };
};

describe('what is answered before the router', () => {
    it('leaves a page to the router', async () => {
        const { get } = setup();
        expect(await get('/about', { accept: 'text/html' })).toBeUndefined();
        expect(await get('/package/react', { accept: 'text/html' })).toBeUndefined();
    });

    it('reads the list of measured packages once for the sitemap index and its files', async () => {
        const { get, measuredPackages } = setup();
        expect(await (await get('/sitemap.xml'))?.text()).toContain('/sitemaps/packages-1.xml');
        expect(await (await get('/sitemaps/packages-1.xml'))?.text()).toContain('/package/react');
        expect(measuredPackages).toHaveBeenCalledTimes(1);
    });

    it('asks the API for a badge once, however often it is fetched', async () => {
        const { get, knownAnalysis } = setup();
        expect(await (await get('/badge/react.svg'))?.text()).toContain('2.9 kB');
        await get('/badge/react.svg');
        expect(knownAnalysis).toHaveBeenCalledTimes(1);
    });

    it('answers a package as Markdown at its twin and to an agent that asks for it, only from what has been measured', async () => {
        const { get } = setup();
        const twin = await get('/package/react.md');
        expect(twin?.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=900');
        expect(await twin?.text()).toContain('# react@19.1.0');
        expect((await get('/package/react', { accept: 'text/markdown' }))?.headers.get('cache-control')).toBe('private, max-age=300');
        const unknown = await setup({ knownAnalysis: async () => undefined }).get('/package/never-measured.md');
        expect(unknown?.status).toBe(404);
        expect(unknown?.headers.get('cache-control')).toBe('no-store');
    });
});

describe("a package's share image", () => {
    it('is drawn once from what has been measured, and kept', async () => {
        const { get, drawPackageImage } = setup();
        const image = await get('/og/package/react.png');
        expect(image?.headers.get('content-type')).toBe('image/png');
        expect(new Uint8Array((await image?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(new Uint8Array([2]));
        await get('/og/package/react%4019.1.0.png');
        expect(drawPackageImage).toHaveBeenCalledTimes(1);
    });

    it("is the site's card for a package not measured, and nothing is drawn", async () => {
        const { get, drawPackageImage } = setup({ knownAnalysis: async () => undefined });
        const card = await get('/og/package/never-measured.png');
        expect(card?.status).toBe(302);
        expect(card?.headers.get('location')).toContain('/og/default.png');
        expect(drawPackageImage).not.toHaveBeenCalled();
    });

    it("is the site's card when drawing fails, and is no address for what is no package", async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { get } = setup({ drawPackageImage: () => Promise.reject(new Error('no font')) });
        expect((await get('/og/package/react.png'))?.status).toBe(302);
        expect(error).toHaveBeenCalled();
        error.mockRestore();
        expect((await get('/og/package/not%20a%20package.png'))?.status).toBe(404);
    });

    it("gives one visitor a few a minute, then the site's card, without asking the API", async () => {
        const { get, knownAnalysis } = setup();
        for (let i = 0; i < 30; i++) expect((await get('/og/package/react.png'))?.status).toBe(200);
        const over = await get('/og/package/react.png');
        expect(over?.status).toBe(302);
        expect(over?.headers.get('cache-control')).toBe('public, max-age=60');
        expect(knownAnalysis).toHaveBeenCalledTimes(30);
    });
});
