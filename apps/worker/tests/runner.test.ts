import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnalyzeMessage } from '@modules/analysis/protocol.ts';
import { runAnalysis } from '@modules/analysis/runner.ts';

const SCRIPT = new URL('./fixtures/analysis.mjs', import.meta.url);

describe('one analysis in a process of its own', () => {
    let dir = '';
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'weighme-runner-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    const run = async (behaviour: string, timeoutMs = 10_000): Promise<AnalyzeMessage[]> => {
        const heard: AnalyzeMessage[] = [];
        const config = { WORKER_DIR: dir, JOB_TIMEOUT_MS: timeoutMs, JOB_MEMORY_MB: 256, MAX_INSTALL_BYTES: 1, PARTS_BUDGET_MS: 0 };
        await runAnalysis(
            { name: behaviour, version: '1.0.0' },
            config,
            async (message) => {
                heard.push(message);
            },
            SCRIPT,
        );
        return heard;
    };

    it('hears the result, then the part-by-part numbers', async () => {
        expect((await run('answers')).map((message) => message.kind)).toEqual(['result', 'exports']);
    });

    it('reports the numbers as failed when the process ends after the result', async () => {
        expect((await run('dies-after-the-result')).map((message) => message.kind)).toEqual(['result', 'exports-failure']);
    });

    it('reports a failure when the process ends before any answer', async () => {
        expect(await run('dies-at-once')).toEqual([{ kind: 'failure', failure: { code: 'INTERNAL', message: 'The analysis process ended early (3)' } }]);
    });

    it('kills an analysis past its time and says so', async () => {
        expect(await run('hangs', 300)).toEqual([{ kind: 'failure', failure: { code: 'TIMEOUT', message: 'The analysis took longer than 300 ms' } }]);
    });

    it('leaves no folder of the job behind', async () => {
        await run('answers');
        expect(await readdir(join(dir, 'jobs')).catch(() => [])).toEqual([]);
    });
});
