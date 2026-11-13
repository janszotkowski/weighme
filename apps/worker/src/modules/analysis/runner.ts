import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PackageRef } from '@weighme/core';
import type { Config } from '@config/env.ts';
import type { AnalyzeMessage, AnalyzeRequest } from './protocol.ts';

/**
 * Only what running pnpm needs. Above all not `WORKER_TOKEN`: the process that handles a package has no secret to lose.
 * PNPM_HOME and COREPACK_HOME are where the pnpm command itself may live.
 */
const PASSED_ENV = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'PNPM_HOME', 'COREPACK_HOME'] as const;

const analysisEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
    for (const name of PASSED_ENV) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
    }
    return env;
};

/**
 * One analysis in a process of its own, in its own process group, so that a package that hangs the bundler, or a pnpm
 * below it, can be killed whole. `onMessage` hears the messages in order, one at a time, and always hears an end: when
 * the process dies, what it still owed is reported as failed. Its folder is removed whatever happened.
 */
export const runAnalysis = async (
    ref: PackageRef,
    config: Pick<Config, 'WORKER_DIR' | 'JOB_TIMEOUT_MS' | 'JOB_MEMORY_MB' | 'MAX_INSTALL_BYTES' | 'PARTS_BUDGET_MS'>,
    onMessage: (message: AnalyzeMessage) => Promise<void>,
): Promise<void> => {
    const dir = join(config.WORKER_DIR, 'jobs', randomUUID());
    const request: AnalyzeRequest = {
        package: ref,
        options: { dir, storeDir: join(config.WORKER_DIR, 'store'), maxInstallBytes: config.MAX_INSTALL_BYTES, partsBudgetMs: config.PARTS_BUDGET_MS },
    };
    let handled = Promise.resolve();
    let answered = false;
    let finished = false;
    const deliver = (message: AnalyzeMessage): void => {
        if (message.kind === 'result' || message.kind === 'failure') answered = true;
        if (message.kind === 'failure' || message.kind === 'exports' || message.kind === 'exports-failure') finished = true;
        handled = handled.then(() => onMessage(message));
    };

    try {
        await new Promise<void>((resolve) => {
            const child = fork(new URL('./main.analyze.mjs', import.meta.url), { env: analysisEnv(), detached: true, execArgv: [`--max-old-space-size=${config.JOB_MEMORY_MB}`] });
            let timedOut = false;
            const end = (reason: string): void => {
                clearTimeout(timer);
                if (!answered) deliver({ kind: 'failure', failure: { code: timedOut ? 'TIMEOUT' : 'INTERNAL', message: reason } });
                else if (!finished) deliver({ kind: 'exports-failure' });
                resolve();
            };
            const killGroup = (): void => {
                if (child.pid === undefined) return;
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch {
                    // The group is already gone.
                }
            };
            const timer = setTimeout(() => {
                timedOut = true;
                killGroup();
            }, config.JOB_TIMEOUT_MS);

            child.on('message', (message) => deliver(message as AnalyzeMessage));
            child.once('error', (error) => end(error.message));
            child.once('exit', (code, signal) => {
                // An install given up on half-way may have left a pnpm behind, still writing to the folder about to be removed.
                killGroup();
                end(timedOut ? `The analysis took longer than ${config.JOB_TIMEOUT_MS} ms` : `The analysis process ended early (${signal ?? code})`);
            });
            child.send(request);
        });
        await handled;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
};
