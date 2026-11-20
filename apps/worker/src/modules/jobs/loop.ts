import type { PackageRef } from '@weighme/core';
import type { Logger } from 'pino';
import type { Config } from '@config/env.ts';
import type { AnalyzeMessage } from '@modules/analysis/protocol.ts';
import { retryDelay, worthLogging } from '@modules/backend/backoff.ts';
import type { BackendClient } from '@modules/backend/client.ts';

/** How often the store's size is looked at whatever happened: walking it costs something, and it grows by one package at a time. */
const STORE_CHECK_MS = 60 * 60_000;

/** What the job loop works with: production passes the backend, a process per analysis and the disk; tests pass their own. */
export type JobLoopDeps = {
    backend: BackendClient;
    /** One analysis (`runAnalysis`): `onMessage` hears its messages in order, and always an end. */
    analyze: (ref: PackageRef, onMessage: (message: AnalyzeMessage) => Promise<void>) => Promise<void>;
    /** The shared pnpm store: what it takes on disk, and a way to empty it whole. */
    store: { bytes: () => Promise<number>; empty: () => Promise<void> };
    /** Waits, and returns early once the signal aborts. */
    sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    now: () => number;
    logger: Pick<Logger, 'info' | 'warn'>;
    limits: Pick<Config, 'WORKER_CONCURRENCY' | 'WORKER_POLL_MS' | 'STORE_MAX_BYTES'>;
};

/**
 * The worker's loop: takes jobs from the backend's queue, as many at a time as there are slots, hands in what each
 * analysis says, and keeps the shared store under its limit while nothing is in flight. It only ever handles what the
 * queue holds, and that holds only what someone asked for: nothing is fetched on its own.
 */
export const createJobLoop = (deps: JobLoopDeps) => {
    const { backend, logger, limits } = deps;

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
        if (deps.now() - storeChecked < STORE_CHECK_MS && installedSince < limits.STORE_MAX_BYTES / 10) return;
        storeChecked = deps.now();
        installedSince = 0;
        const bytes = await deps.store.bytes();
        if (bytes <= limits.STORE_MAX_BYTES) return;
        await deps.store.empty();
        logger.info({ bytes, limit: limits.STORE_MAX_BYTES }, 'store emptied');
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

    /** Hands in what one analysis says, message by message. */
    const handIn = async (job: { id: number; package: PackageRef }, message: AnalyzeMessage, ms: () => number): Promise<void> => {
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
    };

    const slot = async (index: number, signal: AbortSignal): Promise<void> => {
        let failures = 0;
        while (!signal.aborted) {
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
                    const started = deps.now();
                    const ms = (): number => Math.round(deps.now() - started);
                    try {
                        await deps.analyze(job.package, (message) => handIn(job, message, ms));
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
            if (waitForWork) await deps.sleep(retryDelay(failures, limits.WORKER_POLL_MS), signal);
        }
    };

    return {
        /** Weighs the store first, then works until the signal aborts and the jobs in flight have ended. */
        run: async (signal: AbortSignal): Promise<void> => {
            await maintain();
            await Promise.all(Array.from({ length: limits.WORKER_CONCURRENCY }, (_, index) => slot(index, signal)));
        },
    };
};
