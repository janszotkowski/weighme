import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

/**
 * The schema, in order. A step is applied once and recorded in `user_version`, so a new step is appended and never
 * edited: a database created by an older build is brought up to date at start-up.
 *
 * `analyses` is both the store of results and the queue: a row is one package version measured one way, so asking twice
 * for what is already waiting adds nothing.
 */
export const MIGRATIONS: readonly string[] = [
    `
    CREATE TABLE analyses (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        analyzer_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
        result TEXT,
        failure_code TEXT,
        failure_message TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        -- While running: when the job is taken away from a worker that said nothing (milliseconds since the epoch).
        lease_until INTEGER,
        requested_at INTEGER NOT NULL,
        finished_at INTEGER,
        UNIQUE (name, version, analyzer_version)
    );
    CREATE INDEX analyses_queue ON analyses (status, requested_at);
    `,
    // The part-by-part numbers arrive after the result. `exports_until` is when a worker that said nothing is given up on.
    `
    ALTER TABLE analyses ADD COLUMN exports TEXT;
    ALTER TABLE analyses ADD COLUMN exports_status TEXT CHECK (exports_status IN ('pending', 'done', 'unavailable'));
    ALTER TABLE analyses ADD COLUMN exports_until INTEGER;
    `,
    // 0 is someone waiting for this package; 1 is an older version measured on request, after anything that is waited for.
    `
    ALTER TABLE analyses ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
    DROP INDEX analyses_queue;
    CREATE INDEX analyses_queue ON analyses (status, priority, requested_at);
    `,
    // Whether a measured package names a repository is asked before GitHub is, for every row of the trends table.
    `
    CREATE INDEX analyses_repository ON analyses (json_extract(result, '$.repositoryUrl'));
    `,
];

/** Opens (and creates) the database, tuned for one writer and a few readers, and applies the migrations it lacks. */
export const openDatabase = (path: string): Database => {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    // `foreign_keys` is off by default in SQLite; on, so that a later migration with a reference is enforced from the start.
    // `analysis_limit`: ANALYZE (through `PRAGMA optimize`) samples this many rows per index instead of reading every one.
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA analysis_limit = 1000;');
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (const [index, step] of MIGRATIONS.entries()) {
        if (index < row.user_version) continue;
        db.exec('BEGIN');
        try {
            db.exec(step);
            db.exec(`PRAGMA user_version = ${index + 1}`);
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }
    return db;
};

/**
 * Gives the query planner statistics. `PRAGMA optimize` analyzes the tables whose indexes a query used without
 * statistics, or whose size changed a lot, and is cheap when nothing did; a database that was never analyzed is analyzed
 * whole, once (sampled, so it takes no time to speak of). Run now and then while the API serves, and before it closes.
 */
export const optimize = (db: Database): void => {
    const analyzed = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get() as { n: number };
    db.exec(Number(analyzed.n) === 0 ? 'PRAGMA optimize(0x10002)' : 'PRAGMA optimize');
};
