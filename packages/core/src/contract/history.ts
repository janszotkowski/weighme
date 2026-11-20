import * as z from 'zod/mini';

/** Where one version stands. `unmeasured` waits for someone to ask: nothing is downloaded until then. */
export const versionEntrySchema = z.object({
    version: z.string(),
    /** When the version was released, as the registry says. */
    publishedAt: z.nullable(z.string()),
    status: z.enum(['unmeasured', 'queued', 'running', 'done', 'failed']),
    /** Null until it is measured, and for a version with nothing to import. */
    gzip: z.nullable(z.number()),
    minified: z.nullable(z.number()),
});

export type VersionEntry = z.infer<typeof versionEntrySchema>;

/** The answer of `GET /v1/history`: recent releases, newest first. */
export const historyResponseSchema = z.object({ name: z.string(), versions: z.array(versionEntrySchema) });

export type HistoryResponse = z.infer<typeof historyResponseSchema>;

/** How many of a history's versions are queued or running: while there are any, it is worth asking for again. */
export const measuringCount = (history: HistoryResponse): number => history.versions.filter((entry) => entry.status === 'queued' || entry.status === 'running').length;
