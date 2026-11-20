import { ApiError, MAX_SEARCH_LENGTH, MIN_SEARCH_LENGTH, TREND_RANGES, analysisForAgent, readPackageName, readPackageSpec, type TrendRange } from '@weighme/core';
import { canonicalUrl } from '@config/site';
import type { fetchAnalysis, fetchDownloads, fetchHistory, fetchMetadata, fetchSuggestions } from '@lib/api';
import { MAX_TREND_PACKAGES, TREND_GROUPS, TREND_METRICS, groupDownloads, parsePackages, todayIso, validateTrendsSearch, type TrendGroup, type TrendsSearch } from '@lib/trends';

/**
 * WebMCP (webmachinelearning.github.io/webmcp): the page offers AI agents in the browser a few tools of its own, so an
 * agent can search, read and steer the site the way a visitor would instead of guessing at the DOM. Every tool reads
 * the same public API the page does; the ones that change something only move the page (which package is open, what is
 * compared), or ask for a package to be measured, as opening its page does.
 */

type ToolAnnotations = { readOnlyHint?: boolean; untrustedContentHint?: boolean };

export type WebMcpTool = {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: ToolAnnotations;
    execute: (input: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<unknown>;
};

/** What the tools need from the page: the API, and a way to move the page to a package or a comparison. */
export type WebMcpDeps = {
    api: {
        analysis: typeof fetchAnalysis;
        search: typeof fetchSuggestions;
        history: typeof fetchHistory;
        downloads: typeof fetchDownloads;
        metadata: typeof fetchMetadata;
    };
    showPackage: (spec: string) => Promise<void>;
    showTrends: (search: TrendsSearch) => Promise<void>;
};

const PACKAGE_SPEC = { type: 'string', description: 'An npm package name, optionally with a version or tag: react, react@19.1.0, react@next.' } as const;
const PACKAGE_NAME = { type: 'string', description: 'An npm package name, without a version: react.' } as const;

/** The spec a tool was given, as typed, or the reason it is none: an agent gets the problem back instead of a page about nothing. */
const specOf = (input: Record<string, unknown>): string => {
    const text = String(input['package'] ?? '').trim();
    const read = readPackageSpec(text);
    if (!read.ok) throw new ApiError('VALIDATION_FAILED', read.reason);
    return text;
};

const nameOf = (input: Record<string, unknown>): string => {
    const read = readPackageName(String(input['package'] ?? ''));
    if (!read.ok) throw new ApiError('VALIDATION_FAILED', read.reason);
    return read.value;
};

const oneOf = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T => allowed.find((candidate) => candidate === value) ?? fallback;

const trendsUrl = (search: TrendsSearch): string => {
    const params = new URLSearchParams(Object.entries(search).map(([key, value]) => [key, String(value)]));
    return canonicalUrl(`/trends?${params.toString()}`);
};

export const webMcpTools = (deps: WebMcpDeps): WebMcpTool[] => [
    {
        name: 'search_packages',
        title: 'Search npm packages',
        description:
            'Finds npm packages by a text, with their description and weekly downloads. Nothing is measured or downloaded. Does not change the page; use open_package to show one to the user.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: MIN_SEARCH_LENGTH, maxLength: MAX_SEARCH_LENGTH, description: 'What to look for.' } }, required: ['query'] },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async (input, signal) => ({ packages: await deps.api.search(String(input['query'] ?? '').trim(), signal) }),
    },
    {
        name: 'get_package_cost',
        title: 'Get what a package costs',
        description:
            'What an npm package costs a bundle: minified, gzip and brotli bytes, what an install puts on disk, which packages make up the bundle and the size of each export. A package not measured yet is queued, as opening its page does, and the answer says to call again. Does not change the page.',
        inputSchema: { type: 'object', properties: { package: PACKAGE_SPEC }, required: ['package'] },
        annotations: { untrustedContentHint: true },
        execute: async (input, signal) => {
            const answer = await deps.api.analysis(specOf(input), signal);
            return { ...analysisForAgent(answer), url: canonicalUrl(`/package/${answer.package.name}`) };
        },
    },
    {
        name: 'get_package_metadata',
        title: 'Get what the registry says of a version',
        description: 'What the npm registry says of one exact version: deprecation, license, TypeScript types and install scripts. Nothing is downloaded. It does not judge whether a package is safe.',
        inputSchema: {
            type: 'object',
            properties: { name: PACKAGE_NAME, version: { type: 'string', description: 'An exact version: 19.1.0. get_version_history and get_package_cost name them.' } },
            required: ['name', 'version'],
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async (input, signal) => deps.api.metadata(nameOf({ package: input['name'] }), String(input['version'] ?? '').trim(), signal),
    },
    {
        name: 'get_version_history',
        title: 'Get the sizes across releases',
        description: 'Recent versions of a package with their release date and, for the measured ones, their size. Nothing is downloaded. Does not change the page.',
        inputSchema: { type: 'object', properties: { package: PACKAGE_NAME }, required: ['package'] },
        annotations: { readOnlyHint: true },
        execute: async (input, signal) => deps.api.history(nameOf(input), signal),
    },
    {
        name: 'get_downloads',
        title: 'Count downloads over time',
        description: 'Downloads of a package per day, week or month over a period, from npm. Unfinished periods are left out. Does not change the page.',
        inputSchema: {
            type: 'object',
            properties: {
                package: PACKAGE_NAME,
                range: { type: 'string', enum: TREND_RANGES, description: 'How far back. Default "1y".' },
                group: { type: 'string', enum: TREND_GROUPS, description: 'The period of a count. Default "week".' },
            },
            required: ['package'],
        },
        annotations: { readOnlyHint: true },
        execute: async (input, signal) => {
            const range: TrendRange = oneOf(TREND_RANGES, input['range'], '1y');
            const group: TrendGroup = oneOf(TREND_GROUPS, input['group'], 'week');
            const { name, days } = await deps.api.downloads(nameOf(input), range, signal);
            return { name, range, group, points: groupDownloads(days, group, todayIso()).map((point) => ({ start: new Date(point.time).toISOString().slice(0, 10), downloads: point.value })) };
        },
    },
    {
        name: 'open_package',
        title: 'Open a package',
        description: 'Opens the page of a package for the user. A package not measured yet is queued, as opening its page always does.',
        inputSchema: { type: 'object', properties: { package: PACKAGE_SPEC }, required: ['package'] },
        annotations: {},
        execute: async (input) => {
            const text = specOf(input);
            await deps.showPackage(text);
            return { opened: text, url: canonicalUrl(`/package/${text}`) };
        },
    },
    {
        name: 'show_trends',
        title: 'Compare packages on the page',
        description: `Moves the page to the comparison of up to ${MAX_TREND_PACKAGES} packages, by their size across releases or their downloads over time, so the user sees the chart and the table.`,
        inputSchema: {
            type: 'object',
            properties: {
                packages: { type: 'array', items: PACKAGE_NAME, minItems: 1, maxItems: MAX_TREND_PACKAGES, description: 'The packages to compare.' },
                metric: { type: 'string', enum: TREND_METRICS, description: 'Default "size".' },
                range: { type: 'string', enum: TREND_RANGES, description: 'For downloads: how far back. Default "1y".' },
                group: { type: 'string', enum: TREND_GROUPS, description: 'For downloads: the period of a count. Default "week".' },
            },
            required: ['packages'],
        },
        annotations: {},
        execute: async (input) => {
            const named = Array.isArray(input['packages']) ? input['packages'].join(',') : '';
            const names = parsePackages(named);
            if (names.length === 0) throw new ApiError('VALIDATION_FAILED', 'packages must name at least one npm package');
            const search = validateTrendsSearch({ ...input, packages: names.join(',') });
            await deps.showTrends(search);
            return { shown: names, pageUrl: trendsUrl(search) };
        },
    },
];

type ModelContext = {
    registerTool: (tool: Record<string, unknown>, options?: { signal?: AbortSignal }) => unknown;
    unregisterTool?: (name: string) => void;
};

/**
 * The browser's model context: `document.modelContext` in the current draft, `navigator.modelContext` in the earlier
 * one Chrome first shipped behind a flag. Undefined in every browser without WebMCP, where nothing is registered.
 */
const modelContextOf = (): { context: ModelContext; legacy: boolean } | undefined => {
    const current = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (current !== undefined) return { context: current, legacy: false };
    const legacy = (navigator as Navigator & { modelContext?: ModelContext }).modelContext;
    return legacy === undefined ? undefined : { context: legacy, legacy: true };
};

/** Registers the tools with the browser, if it has WebMCP; the returned function takes them back. */
export const registerWebMcpTools = (tools: readonly WebMcpTool[]): (() => void) => {
    const found = modelContextOf();
    if (found === undefined) return () => undefined;
    const { context, legacy } = found;
    const controller = new AbortController();
    for (const tool of tools) {
        // The current draft passes `{ signal }` and serializes the result itself; the earlier one expects MCP's content blocks.
        const execute = async (input: unknown, options?: { signal?: unknown }) => {
            const signal = options?.signal instanceof AbortSignal ? options.signal : undefined;
            const result = await tool.execute(typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}, signal);
            return legacy ? { content: [{ type: 'text', text: JSON.stringify(result) }] } : result;
        };
        try {
            void Promise.resolve(context.registerTool({ ...tool, execute }, { signal: controller.signal })).catch(() => undefined);
        } catch {
            // A tool the browser refuses (a name taken by another registration, say) leaves the others in place.
        }
    }
    return () => {
        controller.abort();
        if (legacy) for (const tool of tools) context.unregisterTool?.(tool.name);
    };
};
