import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleEntry } from '@modules/analysis/bundle.ts';
import { entrySource } from '@modules/analysis/entry.ts';
import { EmptyEntryError } from '@modules/analysis/failure.ts';

/** The real bundler over packages written here: nothing is installed or run. */
let dir: string;

beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'weighme-bundle-')));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const measure = async (code: string) => {
    const folder = join(dir, 'node_modules', 'fixture');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', main: 'index.js' }));
    await writeFile(join(folder, 'index.js'), code);
    const result = await bundleEntry(entrySource('fixture', { type: 'module' }), join(dir, 'entry.mjs'), dir, []);
    return { exports: result.exports, text: result.files.map((file) => file.toString()).join('') };
};

describe('measuring an ES module', () => {
    it('counts a package with only a default export', async () => {
        const { exports, text } = await measure('export default function only() { return "only-default-code"; }\n');
        expect(exports).toEqual(['default']);
        expect(text).toContain('only-default-code');
    });

    it('counts the default export beside the named ones', async () => {
        const { exports, text } = await measure('export const named = "named-code";\nexport default function other() { return "default-code"; }\n');
        expect(exports).toEqual(expect.arrayContaining(['named', 'default']));
        expect(text).toContain('named-code');
        expect(text).toContain('default-code');
    });

    it('still measures a package with no default export', async () => {
        const { exports, text } = await measure('export const named = "named-code";\n');
        expect(exports).toEqual(['named']);
        expect(text).toContain('named-code');
    });

    it("reads nothing outside the job's folder, by a path or through a link, and quotes none of it", async () => {
        const outside = await realpath(await mkdtemp(join(tmpdir(), 'weighme-outside-')));
        try {
            await writeFile(join(outside, 'environ'), 'WORKER_TOKEN=do-not-show');
            await expect(measure(`import ${JSON.stringify(join(outside, 'environ'))};\nexport const named = 1;\n`)).rejects.toMatchObject({
                code: 'BUNDLE_FAILED',
                message: expect.stringContaining('outside'),
            });
            await symlink(join(outside, 'environ'), join(dir, 'node_modules', 'fixture', 'link.js'));
            const linked = await measure('import "./link.js";\nexport const named = 1;\n').catch((error: unknown) => error);
            expect(linked).toMatchObject({ code: 'BUNDLE_FAILED' });
            expect(String((linked as Error).message)).not.toContain('do-not-show');
            expect(String((linked as Error).message)).not.toContain(outside);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });

    it('says so when the entry exports nothing at all', async () => {
        await expect(measure('//# sourceMappingURL=index.js.map\n')).rejects.toBeInstanceOf(EmptyEntryError);
    });
});
