import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pino } from 'pino';
import { loadConfig } from '@config/env.ts';
import { folderBytes } from '@modules/analysis/install.ts';
import { runAnalysis } from '@modules/analysis/runner.ts';
import { createBackendClient } from '@modules/backend/client.ts';
import { createJobLoop } from '@modules/jobs/loop.ts';

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

const loop = createJobLoop({
    backend,
    analyze: (ref, onMessage) => runAnalysis(ref, config, onMessage),
    store: { bytes: () => folderBytes(storeDir), empty: () => rm(storeDir, { recursive: true, force: true }) },
    sleep: (ms, signal) =>
        sleep(ms, undefined, { signal }).then(
            () => undefined,
            () => undefined,
        ),
    now: () => performance.now(),
    logger,
    limits: config,
});

const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    stop.abort();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A worker killed in the middle of a job left that job's folder behind; nothing else is ever in here at start.
await rm(jobsDir, { recursive: true, force: true });
logger.info({ backend: config.BACKEND_URL, dir: config.WORKER_DIR, concurrency: config.WORKER_CONCURRENCY }, 'worker started');
await loop.run(stop.signal);
process.exit(0);
