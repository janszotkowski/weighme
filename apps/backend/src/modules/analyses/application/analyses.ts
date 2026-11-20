import { isExactVersion, type AnalysisResponse, type HistoryResponse, type PackageMetadata, type PackageSpec, type VersionEntry } from '@weighme/core';
import { AppError } from '@platform/errors.ts';
import type { AnalysisRecords, MeasuredPackage, MetadataReader, ReleasedVersion, StarsReader, VersionLister, VersionResolver, VersionSummary } from './ports.ts';

/** What the use cases read from: the store, and npm and GitHub in production; tests pass their own, so they never reach the network. */
export type AnalysesDeps = {
    store: AnalysisRecords;
    resolve: VersionResolver;
    listVersions: VersionLister;
    readStars: StarsReader;
    readMetadata: MetadataReader;
};

/**
 * An analysis, and whether it was asked for by exact version: what a tag points to changes with the next release, the
 * result of an exact version does not, so whoever serves it may keep the second far longer.
 */
export type AnalysisAnswer = { analysis: AnalysisResponse; exact: boolean };

const STATUSES: readonly VersionEntry['status'][] = ['queued', 'running', 'done', 'failed'];

const versionEntry = (released: ReleasedVersion, known: VersionSummary | undefined): VersionEntry => {
    const { version, publishedAt } = released;
    const status = STATUSES.find((candidate) => candidate === known?.status);
    if (known === undefined || status === undefined) return { version, publishedAt, status: 'unmeasured', gzip: null, minified: null };
    return { version, publishedAt, status, gzip: status === 'done' ? known.gzip : null, minified: status === 'done' ? known.minified : null };
};

const exactOf = (spec: PackageSpec): string | undefined => (spec.version !== undefined && isExactVersion(spec.version) ? spec.version : undefined);

/** What can be asked about packages, whoever asks: the HTTP routes and the MCP tools answer with the same use cases. */
export const createAnalyses = (deps: AnalysesDeps) => {
    const { store, resolve, listVersions, readStars, readMetadata } = deps;

    /** The version a spec stands for. An exact one needs no question to the registry. */
    const versionOf = async (spec: PackageSpec): Promise<string> => exactOf(spec) ?? (await resolve(spec.name, spec.version ?? 'latest'));

    const history = async (name: string): Promise<HistoryResponse> => {
        const released = await listVersions(name);
        const known = store.summaries(name);
        return { name, versions: released.map((version) => versionEntry(version, known.get(version.version))) };
    };

    return {
        /**
         * A package's analysis, queued when there is none. An exact version already in the store needs no question to the
         * registry: polling costs it nothing. A failed one is asked about again, so that a version taken off npm meanwhile is not queued once more.
         * `queueShare` is the caller's share of queueing: counted only when this adds the package to the queue, and it may throw to refuse.
         */
        lookUp: async (spec: PackageSpec, queueShare: () => void): Promise<AnalysisAnswer> => {
            const exact = exactOf(spec);
            const known = exact === undefined ? undefined : store.find({ name: spec.name, version: exact });
            if (known !== undefined && known.status !== 'failed') return { analysis: known, exact: true };
            const version = await resolve(spec.name, spec.version ?? 'latest');
            return { analysis: store.findOrEnqueue({ name: spec.name, version }, queueShare), exact: exact !== undefined };
        },

        /** What has been measured of a package, and NOT_FOUND when nothing has: it never queues, so it never causes a download. */
        known: async (spec: PackageSpec): Promise<AnalysisAnswer> => {
            const version = await versionOf(spec);
            const found = store.find({ name: spec.name, version });
            if (found === undefined) throw new AppError('NOT_FOUND', `${spec.name}@${version} has not been measured`);
            return { analysis: found, exact: exactOf(spec) !== undefined };
        },

        /** A package's recent releases, each with where its measurement stands. */
        history,

        /** Queues a package's releases to be measured after anything someone is waiting for, and answers its history. */
        measureHistory: async (name: string): Promise<HistoryResponse> => {
            store.enqueueLater((await listVersions(name)).map(({ version }) => ({ name, version })));
            return history(name);
        },

        /**
         * A repository's stars on GitHub, and null for any that no measured package names as its own: any other name would
         * spend the few questions GitHub allows on whatever a caller made up.
         */
        stars: async (repository: string): Promise<number | null> => (store.knowsRepository(repository) ? readStars(repository) : null),

        /** Only what the registry says about the version: nothing is queued or downloaded for this. */
        metadata: async (spec: PackageSpec): Promise<PackageMetadata> => readMetadata(spec.name, await versionOf(spec)),

        /** Every package with a finished measurement, up to a limit. */
        measuredPackages: (limit: number): MeasuredPackage[] => store.measuredPackages(limit),
    };
};

export type Analyses = ReturnType<typeof createAnalyses>;
