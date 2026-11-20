import { setTimeout as sleep } from 'node:timers/promises';
import { claimResponseSchema, isExactVersion, isValidPackageName, type AnalysisFailure, type AnalysisResult, type ExportDetails, type Job } from '@weighme/core';
import { z } from 'zod';
import type { Config } from '@config/env.ts';

const TIMEOUT_MS = 10_000;
/** A result that took a minute to make is worth a few tries: the backend may be restarting. */
const HAND_IN_ATTEMPTS = 3;
const HAND_IN_RETRY_MS = 1000;

const acceptedSchema = z.object({ accepted: z.boolean() });

/** The worker's only way to the data: it holds no database of its own. `request` is `fetch`, unless a test stands in for the backend. */
export const createBackendClient = (config: Pick<Config, 'BACKEND_URL' | 'WORKER_TOKEN'>, request: typeof fetch = fetch) => {
    const post = async (path: string, body?: unknown): Promise<unknown> => {
        const response = await request(new URL(path, config.BACKEND_URL), {
            method: 'POST',
            headers: { authorization: `Bearer ${config.WORKER_TOKEN}`, 'content-type': 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) throw new Error(`The backend answered ${response.status} to ${path}`);
        return response.json();
    };

    /** Hands something in, trying again when the backend does not take it. False when it did take it but too late: the job's lease had run out. */
    const handIn = async (path: string, body?: unknown): Promise<boolean> => {
        for (let attempt = 1; ; attempt++) {
            try {
                return acceptedSchema.parse(await post(path, body)).accepted;
            } catch (error) {
                if (attempt >= HAND_IN_ATTEMPTS) throw error;
                await sleep(HAND_IN_RETRY_MS * attempt);
            }
        }
    };

    return {
        claim: async (): Promise<Job | undefined> => {
            const { job } = claimResponseSchema.parse(await post('/internal/jobs/claim'));
            if (job === null) return undefined;
            // The name becomes a path and a dependency here: not taken on trust, whoever sent it.
            if (!isValidPackageName(job.package.name) || !isExactVersion(job.package.version)) throw new Error(`The backend sent an invalid package (job ${job.id})`);
            return job;
        },
        complete: (id: number, result: AnalysisResult): Promise<boolean> => handIn(`/internal/jobs/${id}/result`, result),
        fail: (id: number, failure: AnalysisFailure): Promise<boolean> => handIn(`/internal/jobs/${id}/failure`, failure),
        completeExports: (id: number, details: ExportDetails): Promise<boolean> => handIn(`/internal/jobs/${id}/exports`, details),
        failExports: (id: number): Promise<boolean> => handIn(`/internal/jobs/${id}/exports-failure`),
    };
};

export type BackendClient = ReturnType<typeof createBackendClient>;
