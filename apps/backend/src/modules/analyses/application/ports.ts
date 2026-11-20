import type { AnalysisResponse, DownloadsResponse, PackageMetadata, PackageRef, PackageSuggestion, TrendRange } from '@weighme/core';

/** The exact version a version or a dist-tag stands for, as the registry says. */
export type VersionResolver = (name: string, versionOrTag: string) => Promise<string>;

export type PackageSearcher = (query: string) => Promise<PackageSuggestion[]>;

export type ReleasedVersion = { version: string; publishedAt: string | null };

export type VersionLister = (name: string) => Promise<ReleasedVersion[]>;

export type DownloadsReader = (name: string, range: TrendRange) => Promise<DownloadsResponse['days']>;

export type StarsReader = (repository: string) => Promise<number | null>;

export type MetadataReader = (name: string, version: string) => Promise<PackageMetadata>;

/** One line of `GET /v1/packages`. */
export type MeasuredPackage = { name: string; measuredAt: string };

/** What a history shows of one version. The sizes are null until it is measured, and for a package with nothing to import. */
export type VersionSummary = { status: string; gzip: number | null; minified: number | null };

/** What the use cases need of the store: what is known, and the queue. The worker's side of it is not theirs. */
export type AnalysisRecords = {
    find: (ref: PackageRef) => AnalysisResponse | undefined;
    findOrEnqueue: (ref: PackageRef, beforeQueueing?: () => void) => AnalysisResponse;
    enqueueLater: (refs: readonly PackageRef[]) => void;
    summaries: (name: string) => Map<string, VersionSummary>;
    knowsRepository: (ownerAndName: string) => boolean;
    measuredPackages: (limit: number) => MeasuredPackage[];
};
