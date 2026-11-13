import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { PackageRef } from '@weighme/core';
import { AnalysisError } from './failure.ts';

const run = promisify(execFile);

/**
 * pnpm's settings for one analysis, separate from the project's own. `minimumReleaseAge` is off because a brand-new
 * version is exactly what people look up; nothing here runs it. A package may not pull anything from outside the registry.
 */
const WORKSPACE_SETTINGS = `nodeLinker: hoisted
minimumReleaseAge: 0
autoInstallPeers: false
blockExoticSubdeps: true
strictDepBuilds: false
`;

const stderrOf = (error: unknown): string => (typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : String(error));

/** How often the folder is weighed while pnpm fills it. */
const WATCH_MS = 2000;

/**
 * Installs the package into `dir` without running a single script of it or of its dependencies. The user-level npm and
 * pnpm configuration is replaced by empty files: tokens in `~/.npmrc` are not for this install to see. The folder is
 * weighed as it fills, and the install stopped past `maxBytes`: checked only afterwards, a package could fill the disk first.
 */
export const installPackage = async (ref: PackageRef, dir: string, storeDir: string, maxBytes: number): Promise<void> => {
    await mkdir(dir, { recursive: true });
    const userConfig = join(dir, '.user-npmrc');
    await Promise.all([
        writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'weighme-analysis', private: true, dependencies: { [ref.name]: ref.version } })),
        writeFile(join(dir, 'pnpm-workspace.yaml'), WORKSPACE_SETTINGS),
        writeFile(join(dir, '.npmrc'), 'registry=https://registry.npmjs.org/\n'),
        writeFile(userConfig, ''),
    ]);
    const stop = new AbortController();
    let tooLarge: AnalysisError | undefined;
    let weighing = false;
    const watch = setInterval(() => {
        if (weighing) return;
        weighing = true;
        measureInstall(dir, maxBytes)
            .catch((error: unknown) => {
                // Anything else is a file pnpm moved while the folder was read: the next look will do.
                if (!(error instanceof AnalysisError)) return;
                tooLarge = error;
                stop.abort();
            })
            .finally(() => {
                weighing = false;
            });
    }, WATCH_MS);
    try {
        await run('pnpm', ['install', '--ignore-scripts', '--prod', '--store-dir', storeDir, '--reporter=silent'], {
            cwd: dir,
            env: { ...process.env, NPM_CONFIG_USERCONFIG: userConfig, XDG_CONFIG_HOME: join(dir, '.config') },
            maxBuffer: 1024 * 1024,
            signal: stop.signal,
            killSignal: 'SIGKILL',
        });
    } catch (error) {
        throw tooLarge ?? new AnalysisError('INSTALL_FAILED', stderrOf(error));
    } finally {
        clearInterval(watch);
    }
};

/** Every file under `folder`, without following links. `onFile` may throw to stop the walk. */
const walkFiles = async (folder: string, onFile: (path: string, name: string, bytes: number) => void): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) await walkFiles(path, onFile);
        else if (entry.isFile()) onFile(path, entry.name, (await lstat(path)).size);
    }
};

/** What the install put on disk. */
export const measureInstall = async (dir: string, maxBytes: number): Promise<{ bytes: number; packages: number }> => {
    let bytes = 0;
    let packages = 0;
    await walkFiles(join(dir, 'node_modules'), (path, name, size) => {
        bytes += size;
        if (bytes > maxBytes) throw new AnalysisError('TOO_LARGE', `The package and its dependencies take more than ${maxBytes} bytes`);
        const owner = dirname(path);
        const parent = basename(dirname(owner));
        if (name === 'package.json' && (parent === 'node_modules' || (parent.startsWith('@') && basename(dirname(dirname(owner))) === 'node_modules'))) packages++;
    });
    return { bytes, packages };
};

/** What a folder takes on disk; nothing for one that is not there. */
export const folderBytes = async (folder: string): Promise<number> => {
    let bytes = 0;
    try {
        await walkFiles(folder, (_path, _name, size) => {
            bytes += size;
        });
    } catch (error) {
        if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
    }
    return bytes;
};
