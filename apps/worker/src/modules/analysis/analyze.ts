import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnalysisResult, ExportDetails, PackageRef } from '@weighme/core';
import { BUNDLER, bundleEntry, compress, type Bundle } from './bundle.ts';
import { commandsOf, descriptionOf, entrySource, peerNames, type Manifest } from './entry.ts';
import { AnalysisError, EmptyEntryError, NoEntryError } from './failure.ts';
import { installPackage, measureInstall } from './install.ts';
import { measureParts } from './parts.ts';
import { githubUrl } from './repository.ts';

export type AnalyzeOptions = { dir: string; storeDir: string; maxInstallBytes: number; partsBudgetMs: number };

/** The main numbers now, and the part-by-part ones when asked for: they take longer and the page should not wait for them. */
export type Analysis = { result: AnalysisResult; measureParts: () => Promise<ExportDetails> };

const elapsed = (from: number): number => Math.round(performance.now() - from);

/** One package from nothing to its numbers. The package's code is read, never run. */
export const analyze = async (ref: PackageRef, options: AnalyzeOptions): Promise<Analysis> => {
    const installStarted = performance.now();
    await installPackage(ref, options.dir, options.storeDir, options.maxInstallBytes);
    const install = await measureInstall(options.dir, options.maxInstallBytes);
    const installMs = elapsed(installStarted);

    // The temp folder is often reached through a link (`/var` on macOS): the bundler would then name files by long relative paths.
    const dir = await realpath(options.dir);

    let manifest: Manifest;
    try {
        manifest = JSON.parse(await readFile(join(dir, 'node_modules', ref.name, 'package.json'), 'utf8')) as Manifest;
    } catch {
        throw new AnalysisError('INSTALL_FAILED', 'The package has no readable package.json');
    }
    const entry = entrySource(ref.name, manifest);
    const peerDependencies = peerNames(manifest);
    const entryFile = join(dir, 'weighme-entry.mjs');

    const bundleStarted = performance.now();
    let whole: Bundle | undefined;
    try {
        whole = await bundleEntry(entry, entryFile, dir, peerDependencies);
    } catch (error) {
        // An ES module that exports nothing from its root is an answer: some packages are used only through their subpaths.
        // CommonJS is kept alive whole, so nothing of it in the bundle is something gone wrong.
        const nothingToImport = error instanceof NoEntryError || (error instanceof EmptyEntryError && entry.kind === 'export-star');
        if (!nothingToImport) throw error;
    }
    const bundleMs = elapsed(bundleStarted);

    const compressStarted = performance.now();
    const sizes = whole === undefined ? null : await compress(whole.files);
    const compressMs = elapsed(compressStarted);

    return {
        result: {
            bundler: BUNDLER,
            entry: whole === undefined ? null : entry.kind,
            sizes,
            install,
            peerDependencies,
            description: descriptionOf(manifest),
            composition: whole?.composition ?? { packages: [], total: 0 },
            commands: commandsOf(ref.name, manifest),
            environment: whole?.environment ?? { nodeBuiltins: [], nativeAddons: 0, unresolvedImports: 0 },
            repositoryUrl: githubUrl(manifest.repository),
            timingsMs: { install: installMs, bundle: bundleMs, compress: compressMs },
        },
        measureParts: () =>
            measureParts({
                packageName: ref.name,
                manifest,
                dir,
                peers: peerDependencies,
                exportNames: whole?.exports ?? [],
                esm: entry.kind === 'export-star',
                deadline: performance.now() + options.partsBudgetMs,
            }),
    };
};
