import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { gzip as gzipCallback, brotliCompress as brotliCallback, constants } from 'node:zlib';
import { promisify } from 'node:util';
import type { AnalysisResult } from '@weighme/core';
import { rolldown, VERSION } from 'rolldown';
import { compositionOf } from './composition.ts';
import { createExternal, isFatalUnresolved, type NodeUse } from './external.ts';
import type { Entry } from './entry.ts';
import { AnalysisError, EmptyEntryError, NoEntryError } from './failure.ts';

const gzip = promisify(gzipCallback);
const brotli = promisify(brotliCallback);

export const BUNDLER = { name: 'rolldown', version: VERSION };

const OUTSIDE = 'The package imports a file outside itself and its dependencies';

export type Bundle = { files: Buffer[]; exports: string[]; environment: AnalysisResult['environment']; composition: AnalysisResult['composition'] };

/** A path as a pattern that matches only itself. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The bundle's files, what its entry exports and what it needs that no browser has. Only the bundler reads the package
 * here: it parses the code and never runs it. An entry that cannot be resolved throws, and so does a bundle with nothing
 * of the package in it: both would otherwise show a few bytes as if that were the package's real size.
 *
 * Nothing outside `cwd` (the job's folder, by its real path) is read: a package may import any path, and the bundler
 * quotes a file it cannot parse in its error, which is how another process's environment would reach a public page.
 */
export const bundle = async (entry: string, cwd: string, peers: readonly string[]): Promise<Bundle> => {
    const fatal: string[] = [];
    let unresolvedImports = 0;
    let reachedOutside = false;
    const use: NodeUse = { builtins: new Set(), nativeAddons: new Set() };
    let files: Buffer[];
    let exports: string[];
    let modules: [string, number][];
    try {
        const build = await rolldown({
            input: entry,
            cwd,
            platform: 'browser',
            external: createExternal({ peers, use, isInstalled: (name) => existsSync(join(cwd, 'node_modules', name)) }),
            transform: { define: { 'process.env.NODE_ENV': '"production"' } },
            plugins: [
                {
                    name: 'weighme-inside-the-job',
                    // The filter runs in the bundler itself, on the path a link resolved to: the handler hears only of files outside the folder.
                    load: {
                        filter: { id: { exclude: new RegExp(`^${literal(`${cwd}${sep}`)}`) } },
                        handler: (id) => {
                            // The bundler's own modules have no file.
                            if (id.startsWith('\0')) return null;
                            reachedOutside = true;
                            throw new Error(OUTSIDE);
                        },
                    },
                },
            ],
            onLog: (_level, log) => {
                if (log.code !== 'UNRESOLVED_IMPORT') return;
                unresolvedImports++;
                if (isFatalUnresolved(log.message)) fatal.push(log.message);
            },
        });
        const { output } = await build.generate({ format: 'esm', minify: true });
        await build.close();
        files = output.map((file) => {
            if (file.type === 'chunk') return Buffer.from(file.code);
            return typeof file.source === 'string' ? Buffer.from(file.source) : Buffer.from(file.source);
        });
        exports = output.flatMap((file) => (file.type === 'chunk' && file.isEntry ? file.exports : []));
        modules = output.flatMap((file) => (file.type === 'chunk' ? Object.entries(file.modules).map(([id, module]): [string, number] => [id, module.renderedLength]) : []));
    } catch (error) {
        // Said in our own words: the bundler's text for this carries a stack of this machine's paths.
        throw new AnalysisError('BUNDLE_FAILED', reachedOutside ? OUTSIDE : error instanceof Error ? error.message : String(error));
    }
    if (fatal.length > 0) throw new NoEntryError(fatal.join('\n'));
    if (!modules.some(([id]) => id.includes('node_modules'))) throw new EmptyEntryError('The bundle contains nothing of the package');
    return { files, exports, environment: { nodeBuiltins: [...use.builtins].sort(), nativeAddons: use.nativeAddons.size, unresolvedImports }, composition: compositionOf(modules) };
};

/** Writes the entry and bundles it. An entry naming a default export the module does not have fails, so it is then bundled without. */
export const bundleEntry = async (entry: Pick<Entry, 'code' | 'fallback'>, file: string, cwd: string, peers: readonly string[]): Promise<Bundle> => {
    await writeFile(file, entry.code);
    try {
        return await bundle(file, cwd, peers);
    } catch (error) {
        if (entry.fallback === undefined || !(error instanceof AnalysisError) || !error.message.includes('MISSING_EXPORT')) throw error;
    }
    await writeFile(file, entry.fallback);
    return bundle(file, cwd, peers);
};

const total = (buffers: readonly Buffer[]): number => buffers.reduce((sum, buffer) => sum + buffer.length, 0);

/** Compression runs on libuv's threads, so it does not hold up the process. Each file is compressed on its own, as a server would send it. */
export const compress = async (files: readonly Buffer[]): Promise<{ minified: number; gzip: number; brotli: number }> => {
    const [gzipped, brotlied] = await Promise.all([
        Promise.all(files.map((file) => gzip(file, { level: 9 }))),
        Promise.all(files.map((file) => brotli(file, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: file.length } }))),
    ]);
    return { minified: total(files), gzip: total(gzipped), brotli: total(brotlied) };
};

/** A part of a package: brotli at its highest quality would cost most of the time here, for a number nobody compares parts by. */
export const compressPart = async (files: readonly Buffer[]): Promise<{ minified: number; gzip: number }> => ({
    minified: total(files),
    gzip: total(await Promise.all(files.map((file) => gzip(file, { level: 9 })))),
});
