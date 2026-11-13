import { ANALYZER_VERSION, analysisResponseSchema, type AnalysisFailure, type AnalysisResponse, type AnalysisResult, type ExportDetails, type Job, type PackageRef } from '@weighme/core';
import { AppError } from '@platform/errors.ts';
import type { Database } from './database.ts';

type Row = {
    id: number;
    name: string;
    version: string;
    status: string;
    result: string | null;
    failure_code: string | null;
    failure_message: string | null;
    finished_at: number | null;
    exports: string | null;
    exports_status: string | null;
    exports_until: number | null;
    priority: number;
};

/** One line of `GET /v1/packages`. */
export type MeasuredPackage = { name: string; measuredAt: string };

/** What a history shows of one version. The sizes are null until it is measured, and for a package with nothing to import. */
export type VersionSummary = { status: string; gzip: number | null; minified: number | null };

const MEASURED_TTL_MS = 5 * 60_000;

export type StoreOptions = { maxWaiting: number; leaseMs: number; maxAttempts: number; failedRetryMs: number; now?: () => number };

/** 0 is someone waiting for this package; 1 is an older version measured on request, after anything that is waited for. */
type Priority = 0 | 1;

/**
 * A worker that went silent after the main result never sends the rest: past its time, the page stops waiting. The shape
 * is checked with the whole answer below, so the stored JSON is only read here.
 */
const exportsState = (row: Row, at: number): { status: string; details?: unknown } => {
    if (row.exports_status === 'done' && row.exports !== null) return { status: 'done', details: JSON.parse(row.exports) as unknown };
    if (row.exports_status === 'pending' && at < (row.exports_until ?? 0)) return { status: 'pending' };
    return { status: 'unavailable' };
};

export const createAnalysisStore = (db: Database, options: StoreOptions) => {
    const now = options.now ?? Date.now;

    /** A row as the contract has it. The stored result was validated when it came in; validating the whole answer once is what keeps the two in step. */
    const toResponse = (row: Row): AnalysisResponse =>
        analysisResponseSchema.parse({
            package: { name: row.name, version: row.version },
            analyzerVersion: ANALYZER_VERSION,
            status: row.status,
            ...(row.result === null ? {} : { result: JSON.parse(row.result) as unknown, exports: exportsState(row, now()) }),
            ...(row.failure_code === null ? {} : { failure: { code: row.failure_code, message: row.failure_message ?? '' } }),
        });

    const measured = db.prepare("SELECT name, max(finished_at) AS finished_at FROM analyses WHERE status = 'done' AND analyzer_version = ? GROUP BY name ORDER BY name LIMIT ?");
    const select = db.prepare('SELECT * FROM analyses WHERE name = ? AND version = ? AND analyzer_version = ?');
    // Of this way of measuring only: what was queued for an older one is never claimed, and must not take the room of what is.
    const waiting = db.prepare("SELECT count(*) AS waiting FROM analyses WHERE status = 'queued' AND priority = ? AND analyzer_version = ?");
    const outdated = db.prepare('DELETE FROM analyses WHERE analyzer_version < ?');
    const summaries = db.prepare(
        "SELECT version, status, json_extract(result, '$.sizes.gzip') AS gzip, json_extract(result, '$.sizes.minified') AS minified FROM analyses WHERE name = ? AND analyzer_version = ?",
    );
    // A package in a monorepo names its folder after the repository's address: `/` is the character before `0`.
    const repository = db.prepare(
        `SELECT 1 AS known FROM analyses
         WHERE json_extract(result, '$.repositoryUrl') = ? OR (json_extract(result, '$.repositoryUrl') >= ? AND json_extract(result, '$.repositoryUrl') < ?)
         LIMIT 1`,
    );
    const running = db.prepare("SELECT count(*) AS running FROM analyses WHERE status = 'running'");
    const insert = db.prepare("INSERT INTO analyses (name, version, analyzer_version, status, requested_at) VALUES (?, ?, ?, 'queued', ?) RETURNING *");
    const insertLater = db.prepare("INSERT OR IGNORE INTO analyses (name, version, analyzer_version, status, requested_at, priority) VALUES (?, ?, ?, 'queued', ?, 1)");
    const promote = db.prepare('UPDATE analyses SET priority = 0 WHERE id = ? RETURNING *');
    const requeue = db.prepare("UPDATE analyses SET status = 'queued', failure_code = NULL, failure_message = NULL, attempts = 0, finished_at = NULL, requested_at = ? WHERE id = ? RETURNING *");
    const giveUp = db.prepare(
        "UPDATE analyses SET status = 'failed', failure_code = 'TIMEOUT', failure_message = 'The analysis did not finish', lease_until = NULL, finished_at = ? WHERE status = 'running' AND lease_until < ? AND attempts >= ?",
    );
    const expire = db.prepare("UPDATE analyses SET status = 'queued', lease_until = NULL WHERE status = 'running' AND lease_until < ? AND attempts < ?");
    const claimNext = db.prepare(
        `UPDATE analyses SET status = 'running', attempts = attempts + 1, lease_until = ?
         WHERE id = (SELECT id FROM analyses WHERE status = 'queued' AND analyzer_version = ? ORDER BY priority, requested_at, id LIMIT 1)
         RETURNING id, name, version`,
    );
    const finish = db.prepare(
        "UPDATE analyses SET status = 'done', result = ?, exports_status = 'pending', exports_until = ?, lease_until = NULL, finished_at = ? WHERE id = ? AND status = 'running'",
    );
    const failJob = db.prepare("UPDATE analyses SET status = 'failed', failure_code = ?, failure_message = ?, lease_until = NULL, finished_at = ? WHERE id = ? AND status = 'running'");
    const finishExports = db.prepare("UPDATE analyses SET exports = ?, exports_status = 'done', exports_until = NULL WHERE id = ? AND exports_status = 'pending'");
    const failExports = db.prepare("UPDATE analyses SET exports_status = 'unavailable', exports_until = NULL WHERE id = ? AND exports_status = 'pending'");

    /** Each priority has a line of its own: versions queued for later cannot crowd out what someone is waiting for. */
    const assertRoom = (priority: Priority, adding: number): void => {
        const { waiting: count } = waiting.get(priority, ANALYZER_VERSION) as { waiting: number };
        if (count + adding > options.maxWaiting) {
            throw new AppError('UNAVAILABLE', priority === 0 ? 'Too many packages are waiting to be analyzed; try again in a moment' : 'Too many versions are waiting to be analyzed; try again later');
        }
    };

    let listed: { packages: MeasuredPackage[]; limit: number; until: number } | undefined;

    return {
        /**
         * Every package with a finished measurement, up to a limit. The list reads every finished row, and only a sitemap
         * asks for it, so it is kept for a few minutes: a package measured meanwhile is listed a little later.
         */
        measuredPackages: (limit: number): MeasuredPackage[] => {
            const at = now();
            if (listed === undefined || listed.limit !== limit || at >= listed.until) {
                const rows = measured.all(ANALYZER_VERSION, limit) as { name: string; finished_at: number }[];
                listed = { packages: rows.map((row) => ({ name: row.name, measuredAt: new Date(row.finished_at).toISOString() })), limit, until: at + MEASURED_TTL_MS };
            }
            return listed.packages;
        },

        /**
         * The status and the sizes of every version of a package that is known, by version. A history asks for these two
         * numbers of ten versions every other second: read whole, each would be megabytes of JSON parsed for them.
         */
        summaries: (name: string): Map<string, VersionSummary> =>
            new Map((summaries.all(name, ANALYZER_VERSION) as (VersionSummary & { version: string })[]).map(({ version, ...summary }) => [version, summary])),

        /** Whether a measured package names this GitHub repository (`owner/name`) as its own. */
        knowsRepository: (ownerAndName: string): boolean => {
            const url = `https://github.com/${ownerAndName}`;
            return repository.get(url, `${url}/`, `${url}0`) !== undefined;
        },

        /**
         * Removes what an older way of measuring left: its results are no longer served, and what it left waiting is never
         * claimed. Answers how many rows went. A newer one's rows stay, so that going back a build loses nothing.
         */
        forgetOutdated: (): number => Number(outdated.run(ANALYZER_VERSION).changes),

        /** What is known of a package, without asking for anything. */
        find: (ref: PackageRef): AnalysisResponse | undefined => {
            const row = select.get(ref.name, ref.version, ANALYZER_VERSION) as Row | undefined;
            return row === undefined ? undefined : toResponse(row);
        },

        /**
         * What is known of a package, queueing it when nothing is, or when its last failure is old enough to try again.
         * `beforeQueueing` is called when this adds to the queue, and may throw to refuse: asking for what is known is free.
         */
        findOrEnqueue: (ref: PackageRef, beforeQueueing?: () => void): AnalysisResponse => {
            const row = select.get(ref.name, ref.version, ANALYZER_VERSION) as Row | undefined;
            if (row === undefined) {
                assertRoom(0, 1);
                beforeQueueing?.();
                return toResponse(insert.get(ref.name, ref.version, ANALYZER_VERSION, now()) as Row);
            }
            if (row.status === 'failed' && now() - (row.finished_at ?? 0) >= options.failedRetryMs) {
                assertRoom(0, 1);
                beforeQueueing?.();
                return toResponse(requeue.get(now(), row.id) as Row);
            }
            // Someone is now waiting for what was queued for later.
            if (row.status === 'queued' && row.priority > 0) return toResponse(promote.get(row.id) as Row);
            return toResponse(row);
        },

        /** Queues versions to be measured after anything someone is waiting for: all of them, or none when there is no room. What is already known stays as it is. */
        enqueueLater: (refs: readonly PackageRef[]): void => {
            const unknown = refs.filter((ref) => select.get(ref.name, ref.version, ANALYZER_VERSION) === undefined);
            if (unknown.length === 0) return;
            assertRoom(1, unknown.length);
            const at = now();
            db.exec('BEGIN');
            try {
                for (const ref of unknown) insertLater.run(ref.name, ref.version, ANALYZER_VERSION, at);
                db.exec('COMMIT');
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },

        /** The oldest waiting package, for one worker. A job whose worker went silent goes back in line first, or fails when it has had its tries. */
        claim: (): Job | undefined => {
            const at = now();
            // Leases only matter while something runs: a worker asking every second finds nothing to write most of the time.
            if ((running.get() as { running: number }).running > 0) {
                giveUp.run(at, at, options.maxAttempts);
                expire.run(at, options.maxAttempts);
            }
            const row = claimNext.get(at + options.leaseMs, ANALYZER_VERSION) as Pick<Row, 'id' | 'name' | 'version'> | undefined;
            return row === undefined ? undefined : { id: row.id, package: { name: row.name, version: row.version } };
        },

        /** False when the job is no longer running (its lease ran out): the late answer is dropped. The part-by-part numbers are now awaited. */
        complete: (id: number, result: AnalysisResult): boolean => {
            const at = now();
            return Number(finish.run(JSON.stringify(result), at + options.leaseMs, at, id).changes) > 0;
        },

        fail: (id: number, failure: AnalysisFailure): boolean => Number(failJob.run(failure.code, failure.message, now(), id).changes) > 0,

        completeExports: (id: number, details: ExportDetails): boolean => Number(finishExports.run(JSON.stringify(details), id).changes) > 0,

        /** The main result stands: only the part-by-part numbers are given up on. */
        failExports: (id: number): boolean => Number(failExports.run(id).changes) > 0,
    };
};

export type AnalysisStore = ReturnType<typeof createAnalysisStore>;
