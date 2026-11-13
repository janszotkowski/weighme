import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pino } from 'pino';
import { loadConfig } from '@config/env.ts';
import { folderBytes } from '@modules/analysis/install.ts';
import { runAnalysis } from '@modules/analysis/runner.ts';
import { retryDelay, worthLogging } from '@modules/backend/backoff.ts';
import { createBackendClient } from '@modules/backend/client.ts';

const loaded = loadConfig();
if (!loaded.ok) {
    process.stderr.write(`Invalid configuration:\n${loaded.problems.map((problem) => `  - ${problem}`).join('\n')}\n`);
    process.exit(1);
}
const config = loaded.config;
const logger = pino({ level: config.LOG_LEVEL, base: { service: 'worker' }, messageKey: 'msg', timestamp: pino.stdTimeFunctions.isoTime, formatters: { level: (label) => ({ level: label }) } });
const backend = createBackendClient(config);

const stop = new AbortController();

const jobsDir = join(config.WORKER_DIR, 'jobs');
const storeDir = join(config.WORKER_DIR, 'store');

/** How often the store's size is looked at whatever happened: walking it costs something, and it grows by one package at a time. */
const STORE_CHECK_MS = 60 * 60_000;
let storeChecked = Number.NEGATIVE_INFINITY;
/**
 * What was installed since the store was last weighed. A failed analysis says nothing of what it left there (an install
 * stopped half-way, a package too large), so after one it is unknown, and the store is weighed.
 */
let installedSince = 0;

/**
 * The shared store keeps every package ever installed here, so that the next analysis downloads less; past its limit it
 * is emptied whole, since nothing in it is referenced once a job's folder is gone. Only ever run with no job in flight.
 * It is weighed every hour, and sooner once a tenth of its limit may have been added: an hour of large packages would
 * otherwise fill the disk the limit is there to keep free.
 */
const trimStore = async (): Promise<void> => {
    if (performance.now() - storeChecked < STORE_CHECK_MS && installedSince < config.STORE_MAX_BYTES / 10) return;
    storeChecked = performance.now();
    installedSince = 0;
    const bytes = await folderBytes(storeDir);
    if (bytes <= config.STORE_MAX_BYTES) return;
    await rm(storeDir, { recursive: true, force: true });
    logger.info({ bytes, limit: config.STORE_MAX_BYTES }, 'store emptied');
};

/** Jobs in flight, and the store maintenance every slot waits for before taking the next one. */
let active = 0;
let maintenance: Promise<void> | undefined;

const maintain = (): Promise<void> => {
    maintenance ??= trimStore()
        .catch((error: unknown) => logger.warn({ err: error }, 'store maintenance failed'))
        .finally(() => {
            maintenance = undefined;
        });
    return maintenance;
};

/** It only ever handles what the backend's queue holds, and that holds only what someone asked for: nothing is fetched on its own. */
const slot = async (index: number): Promise<void> => {
    let failures = 0;
    while (!stop.signal.aborted) {
        let waitForWork = false;
        try {
            if (maintenance !== undefined) await maintenance;
            const job = await backend.claim();
            if (failures > 0) logger.info({ slot: index, failures }, 'backend reachable again');
            failures = 0;
            if (job === undefined) {
                waitForWork = true;
            } else {
                // Checked again after the wait for the backend, and counted at once: maintenance starts only when nothing is in flight.
                if (maintenance !== undefined) await maintenance;
                active++;
                const started = performance.now();
                const ms = (): number => Math.round(performance.now() - started);
                try {
                    await runAnalysis(job.package, config, async (message) => {
                        switch (message.kind) {
                            case 'result': {
                                installedSince += message.result.install.bytes;
                                const accepted = await backend.complete(job.id, message.result);
                                if (accepted) logger.info({ package: job.package, ms: ms(), sizes: message.result.sizes }, 'analyzed');
                                else logger.warn({ package: job.package, ms: ms() }, 'analyzed too late: the backend had given the job away');
                                break;
                            }
                            case 'failure':
                                installedSince = Number.POSITIVE_INFINITY;
                                await backend.fail(job.id, message.failure);
                                logger.warn({ package: job.package, ms: ms(), failure: message.failure }, 'analysis failed');
                                break;
                            case 'exports':
                                await backend.completeExports(job.id, message.exports);
                                logger.info({ package: job.package, ms: ms(), named: message.exports.named.length, subpaths: message.exports.subpaths.length }, 'exports measured');
                                break;
                            case 'exports-failure':
                                await backend.failExports(job.id);
                                logger.warn({ package: job.package, ms: ms() }, 'exports not measured');
                                break;
                        }
                    });
                } finally {
                    active--;
                    if (active === 0) await maintain();
                }
            }
        } catch (error) {
            // The backend may simply not be up yet: try again in a while, less often the longer it stays away.
            failures++;
            if (worthLogging(failures)) logger.warn({ slot: index, failures, err: error }, 'worker loop');
            waitForWork = true;
        }
        if (waitForWork) await sleep(retryDelay(failures, config.WORKER_POLL_MS), undefined, { signal: stop.signal }).catch(() => undefined);
    }
};

const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    stop.abort();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A worker killed in the middle of a job left that job's folder behind; nothing else is ever in here at start.
await rm(jobsDir, { recursive: true, force: true });
await maintain();
logger.info({ backend: config.BACKEND_URL, dir: config.WORKER_DIR, concurrency: config.WORKER_CONCURRENCY }, 'worker started');
await Promise.all(Array.from({ length: config.WORKER_CONCURRENCY }, (_, index) => slot(index)));
process.exit(0);
