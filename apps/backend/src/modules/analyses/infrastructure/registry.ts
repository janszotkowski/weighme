import { TREND_RANGE_DAYS, isExactVersion, isValidPackageName, type DownloadsResponse, type PackageMetadata, type PackageSuggestion, type TrendRange } from '@weighme/core';
import { rangeChunks } from '@modules/analyses/application/download-ranges.ts';
import { selectVersions } from '@modules/analyses/application/versions.ts';
import { AppError } from '@platform/errors.ts';

const REGISTRY = 'https://registry.npmjs.org';
const DOWNLOADS_API = 'https://api.npmjs.org/downloads/range';
const TIMEOUT_MS = 10_000;
const FULL_DOCUMENT_TIMEOUT_MS = 30_000;
const HOUR_MS = 3_600_000;

const SEARCH_SIZE = 8;
const MAX_DESCRIPTION = 160;

export type VersionResolver = (name: string, versionOrTag: string) => Promise<string>;

export type PackageSearcher = (query: string) => Promise<PackageSuggestion[]>;

export type ReleasedVersion = { version: string; publishedAt: string | null };

export type VersionLister = (name: string) => Promise<ReleasedVersion[]>;

export type DownloadsReader = (name: string, range: TrendRange) => Promise<DownloadsResponse['days']>;

export type StarsReader = (repository: string) => Promise<number | null>;

export type MetadataReader = (name: string, version: string) => Promise<PackageMetadata>;

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** What an answer may weigh: a version's document or a search page is kilobytes, so anything past this is not the answer asked for. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** A popular package's full document runs to tens of megabytes; past this it is given up on rather than held in memory whole. */
export const FULL_DOCUMENT_MAX_BYTES = 64 * 1024 * 1024;

type Question = {
    url: string;
    /** Who is asked, for the message when it does not answer: the npm registry unless said otherwise. */
    service?: string;
    timeoutMs?: number;
    /** How many bytes of body are read before the answer is given up on; `MAX_BODY_BYTES` unless said otherwise. */
    maxBytes?: number;
    headers?: Record<string, string>;
    /** What a 404 means, as the message of NOT_FOUND. Without it, a 404 is an answer: `undefined`, for the caller to read. */
    notFound?: string;
};

/**
 * The body, read a chunk at a time and counted: `undefined` once it passes `maxBytes`, with the rest of it refused, so a
 * document that is too large is never held whole, let alone parsed on the thread that serves requests.
 */
const readCapped = async (body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | undefined> => {
    if (body === null) return new Uint8Array();
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                return undefined;
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks);
};

/**
 * JSON from an outside service, or an AppError: UNAVAILABLE when it did not answer in time, answered with an error, sent
 * no JSON (the timeout covers the body too, so reading it can fail as the request can) or sent more than `maxBytes`, and
 * NOT_FOUND for a 404. The registry answers 405 for a name it has no document for, which means the same.
 */
const askJson = async (question: Question): Promise<unknown> => {
    const service = question.service ?? 'The npm registry';
    const maxBytes = question.maxBytes ?? MAX_BODY_BYTES;
    let response: Response;
    try {
        response = await fetch(question.url, { headers: { accept: 'application/json', ...question.headers }, signal: AbortSignal.timeout(question.timeoutMs ?? TIMEOUT_MS) });
    } catch {
        throw new AppError('UNAVAILABLE', `${service} did not answer`);
    }
    if (response.status === 404 || response.status === 405) {
        await response.body?.cancel();
        if (question.notFound === undefined) return undefined;
        throw new AppError('NOT_FOUND', question.notFound);
    }
    if (!response.ok) {
        await response.body?.cancel();
        throw new AppError('UNAVAILABLE', `${service} answered ${response.status}`);
    }
    // A declared length past the cap is refused before a byte of it is read; an undeclared one is counted as it comes.
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
        await response.body?.cancel();
        throw new AppError('UNAVAILABLE', `${service} sent too much data`);
    }
    let bytes: Uint8Array | undefined;
    try {
        bytes = await readCapped(response.body, maxBytes);
    } catch {
        throw new AppError('UNAVAILABLE', `${service} sent an unexpected answer`);
    }
    if (bytes === undefined) throw new AppError('UNAVAILABLE', `${service} sent too much data`);
    try {
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
        throw new AppError('UNAVAILABLE', `${service} sent an unexpected answer`);
    }
};

const CACHE_MAX = 500;

/**
 * A small cache for what an outside service would rather not be asked often. A value being fetched is shared with everyone
 * who asks for it meanwhile, so a burst of the same question costs one request. A failure is not kept, unless `failureTtl`
 * says for how long: where asking is costly, the same failure is then answered from here for a while. Past `CACHE_MAX`
 * entries the oldest goes.
 */
const remember = <T>(now: () => number, ttlMs: number, failureTtl: (error: unknown) => number = () => 0) => {
    const cache = new Map<string, { value: T; until: number }>();
    const failures = new Map<string, { error: unknown; until: number }>();
    const pending = new Map<string, Promise<T>>();
    return {
        /** The value for `key`: kept, on its way for someone else, or made now. `ttl` may give a value its own lifetime. */
        share: (key: string, make: () => Promise<T>, ttl: (value: T) => number = () => ttlMs): Promise<T> => {
            const entry = cache.get(key);
            if (entry !== undefined && now() < entry.until) return Promise.resolve(entry.value);
            const failure = failures.get(key);
            if (failure !== undefined && now() < failure.until) return Promise.reject(failure.error);
            const inFlight = pending.get(key);
            if (inFlight !== undefined) return inFlight;
            const promise = make()
                .then(
                    (value) => {
                        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value ?? key);
                        cache.set(key, { value, until: now() + ttl(value) });
                        failures.delete(key);
                        return value;
                    },
                    (error: unknown) => {
                        const keptMs = failureTtl(error);
                        if (keptMs > 0) {
                            failures.delete(key);
                            if (failures.size >= CACHE_MAX) failures.delete(failures.keys().next().value ?? key);
                            failures.set(key, { error, until: now() + keptMs });
                        }
                        throw error;
                    },
                )
                .finally(() => pending.delete(key));
            pending.set(key, promise);
            return promise;
        },
    };
};

/** What a full line answers: the one failure that says nothing about the question asked, so it is never kept for it. */
const BUSY = new AppError('UNAVAILABLE', 'Too many packages are being looked up; try again in a moment');

/**
 * Runs tasks at most `limit` at a time; the rest wait their turn, in order, and at most `maxWaiting` of them: one more is
 * refused at once, so a burst of costly questions is answered "later" instead of growing a line nobody waits at the end of.
 */
const atMost = (limit: number, maxWaiting: number) => {
    let running = 0;
    const waiting: (() => void)[] = [];
    return async <T>(task: () => Promise<T>): Promise<T> => {
        if (running >= limit) {
            if (waiting.length >= maxWaiting) throw BUSY;
            await new Promise<void>((resolve) => waiting.push(resolve));
        }
        running++;
        try {
            return await task();
        } finally {
            running--;
            waiting.shift()?.();
        }
    };
};

/**
 * The exact version behind `latest`, another dist-tag or a version someone typed, from the registry's small document of
 * one version: the document of a whole package can be megabytes. `name` has passed `isValidPackageName`, so it is safe in
 * the path; the slash of a scoped name stays a slash, which is the form the registry answers on this path.
 */
export const resolveFromRegistry: VersionResolver = async (name, versionOrTag) => {
    const manifest = record(await askJson({ url: `${REGISTRY}/${name}/${encodeURIComponent(versionOrTag)}`, notFound: `${name}@${versionOrTag} is not on npm` }));
    if (typeof manifest['version'] !== 'string') throw new AppError('UNAVAILABLE', 'The npm registry sent an unexpected answer');
    return manifest['version'];
};

/** The registry's answer, in its order, without anything that could not be looked up afterwards. */
export const parseSearch = (answer: unknown): PackageSuggestion[] => {
    const objects = record(answer)['objects'];
    if (!Array.isArray(objects)) return [];
    return objects.flatMap((object): PackageSuggestion[] => {
        const found = record(object);
        const pkg = record(found['package']);
        const { name, version, description } = pkg;
        if (typeof name !== 'string' || typeof version !== 'string' || !isValidPackageName(name) || !isExactVersion(version)) return [];
        const weekly = record(found['downloads'])['weekly'];
        return [
            {
                name,
                version,
                description: typeof description === 'string' && description !== '' ? description.slice(0, MAX_DESCRIPTION) : null,
                weeklyDownloads: typeof weekly === 'number' ? weekly : null,
            },
        ];
    });
};

/** Names and descriptions from the registry's search: no package is downloaded for this. */
export const searchRegistry: PackageSearcher = async (query) => parseSearch(await askJson({ url: `${REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=${SEARCH_SIZE}` }));

const VERSIONS_TTL_MS = 10 * 60_000;
/** The registry's full documents run to tens of megabytes and are parsed on the one thread that serves requests: few at a time. */
const FULL_DOCUMENTS_AT_ONCE = 2;
/** A document takes a second or two, and a request gives up after fifteen: nobody is still there for one further back. */
const FULL_DOCUMENTS_WAITING = 8;
/** A document that could not be read (no such package, too large, no answer) is not asked for again at once: each try may read tens of megabytes. */
const VERSIONS_FAILURE_TTL_MS = 60_000;

/**
 * The releases worth showing for a package, with their dates. Only the registry's full document has the dates, and it runs
 * to tens of megabytes for a popular package, so only the pick is kept, for a while, and a burst of questions about one
 * package reads the document once.
 */
export const createVersionLister = (now: () => number = Date.now): VersionLister => {
    const cache = remember<ReleasedVersion[]>(now, VERSIONS_TTL_MS, (error) => (error === BUSY ? 0 : VERSIONS_FAILURE_TTL_MS));
    const fewAtATime = atMost(FULL_DOCUMENTS_AT_ONCE, FULL_DOCUMENTS_WAITING);
    return (name) =>
        cache.share(name, () =>
            fewAtATime(async () => {
                const document = record(await askJson({ url: `${REGISTRY}/${name}`, timeoutMs: FULL_DOCUMENT_TIMEOUT_MS, maxBytes: FULL_DOCUMENT_MAX_BYTES, notFound: `${name} is not on npm` }));
                const latest = record(document['dist-tags'])['latest'];
                const time = record(document['time']);
                const dateOf = (version: string): string | undefined => {
                    const date = time[version];
                    return typeof date === 'string' ? date : undefined;
                };
                const picked = typeof latest === 'string' ? selectVersions(Object.keys(record(document['versions'])), latest, dateOf) : [];
                return picked.map((version) => ({ version, publishedAt: dateOf(version) ?? null }));
            }),
        );
};

/** A package's downloads per day from npm's own statistics. npm updates them once a day. */
export const createDownloadsReader = (now: () => number = Date.now): DownloadsReader => {
    const cache = remember<DownloadsResponse['days']>(now, HOUR_MS);
    return (name, range) =>
        cache.share(`${range}:${name}`, async () => {
            const parts = await Promise.all(
                rangeChunks(new Date(now()), TREND_RANGE_DAYS[range]).map(async (chunk) => {
                    const answer = await askJson({ url: `${DOWNLOADS_API}/${chunk.start}:${chunk.end}/${name}`, service: 'npm' });
                    // npm answers 404 for a period before the package existed: that is no downloads, not a failure.
                    if (answer === undefined) return [];
                    const rows = record(answer)['downloads'];
                    return Array.isArray(rows)
                        ? rows.flatMap((row) => {
                              const { day, downloads } = record(row);
                              return typeof day === 'string' && typeof downloads === 'number' ? [{ day, downloads }] : [];
                          })
                        : [];
                }),
            );
            return parts.flat();
        });
};

const RESOLVED_TTL_MS = 60_000;

/** What a name or tag resolved to, kept for a minute: every package page starts with this question, and a new release can wait that long. A failure is not kept. */
export const cacheResolver = (resolve: VersionResolver, now: () => number = Date.now): VersionResolver => {
    const cache = remember<string>(now, RESOLVED_TTL_MS);
    return (name, versionOrTag) => cache.share(`${name}@${versionOrTag}`, () => resolve(name, versionOrTag));
};

const MAX_DEPRECATED = 500;
const MAX_LICENSE = 100;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const;

const licenseOf = (document: Record<string, unknown>): string | null => {
    const { license, licenses } = document;
    const first: unknown = Array.isArray(licenses) ? licenses[0] : undefined;
    const named = typeof license === 'string' ? license : (record(license)['type'] ?? record(first)['type']);
    return typeof named === 'string' && named.trim() !== '' ? named.trim().slice(0, MAX_LICENSE) : null;
};

const hasTypesCondition = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(hasTypesCondition);
    if (typeof value !== 'object' || value === null) return false;
    return Object.entries(value).some(([key, inner]) => key === 'types' || hasTypesCondition(inner));
};

/** What a version's document in the registry says of itself. An empty `deprecated` is how npm takes a deprecation back. */
export const parseVersionFacts = (answer: unknown): Pick<PackageMetadata, 'deprecated' | 'license' | 'installScripts'> & { typesIncluded: boolean } => {
    const document = record(answer);
    const { deprecated, types, typings, exports, gypfile } = document;
    const scripts = record(document['scripts']);
    return {
        deprecated: deprecated === true ? 'This version is deprecated.' : typeof deprecated === 'string' && deprecated.trim() !== '' ? deprecated.trim().slice(0, MAX_DEPRECATED) : null,
        license: licenseOf(document),
        typesIncluded: (typeof types === 'string' && types !== '') || (typeof typings === 'string' && typings !== '') || hasTypesCondition(exports),
        // A package with a `binding.gyp` is built on install even when it names no script.
        installScripts: [...INSTALL_SCRIPTS.filter((script) => typeof scripts[script] === 'string'), ...(gypfile === true && typeof scripts['install'] !== 'string' ? ['node-gyp'] : [])],
    };
};

/** The name DefinitelyTyped gives a package: `@scope/name` becomes `@types/scope__name`. */
export const definitelyTypedName = (name: string): string => `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`;

/** Whether the registry has a package of this name: its small `latest` document, read for nothing but its existence. */
const isOnRegistry = async (name: string): Promise<boolean> => (await askJson({ url: `${REGISTRY}/${name}/latest` })) !== undefined;

/** What npm says about one version: its small document in the registry, and the `@types` package when it declares no types. Nothing is installed. Kept for an hour. */
export const createMetadataReader = (now: () => number = Date.now): MetadataReader => {
    const cache = remember<PackageMetadata>(now, HOUR_MS);
    return (name, version) => {
        const key = `${name}@${version}`;
        return cache.share(key, async () => {
            const { typesIncluded, ...facts } = parseVersionFacts(await askJson({ url: `${REGISTRY}/${name}/${encodeURIComponent(version)}`, notFound: `${key} is not on npm` }));
            const typesName = definitelyTypedName(name);
            const separate = !typesIncluded && (await isOnRegistry(typesName));
            return { name, version, ...facts, types: typesIncluded ? 'included' : separate ? 'separate' : 'none', typesPackage: separate ? typesName : null };
        });
    };
};

const STARS_TTL_MS = 6 * HOUR_MS;
const STARS_RETRY_MS = 10 * 60_000;

/**
 * A repository's stars from GitHub, kept for hours: without a token GitHub allows 60 questions an hour. Failing costs only
 * the number, so it answers null, and is not asked again for a while.
 */
export const createStarsReader = (token: string | undefined, now: () => number = Date.now): StarsReader => {
    const cache = remember<{ stars: number | null }>(now, STARS_TTL_MS);
    return async (repository) => {
        const { stars } = await cache.share(
            repository,
            async () => {
                try {
                    const answer = await askJson({
                        url: `https://api.github.com/repos/${repository}`,
                        service: 'GitHub',
                        headers: { accept: 'application/vnd.github+json', 'user-agent': 'weighme', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
                    });
                    const count = record(answer)['stargazers_count'];
                    return { stars: typeof count === 'number' ? count : null };
                } catch {
                    // Any answer without a number is the same to the page: no stars for a while.
                    return { stars: null };
                }
            },
            (value) => (value.stars === null ? STARS_RETRY_MS : STARS_TTL_MS),
        );
        return stars;
    };
};
