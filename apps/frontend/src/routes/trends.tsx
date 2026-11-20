import { measuringCount } from '@weighme/core';
import { keepPreviousData, useQueries } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { LoaderCircle } from 'lucide-react';
import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { IsoPackage } from '@components/iso/IsoPackage';
import { PackageChips, type ChipFocus } from '@components/PackageChips';
import { TrendsChart } from '@components/TrendsChart';
import { TrendsControls } from '@components/TrendsControls';
import { TrendsTable, type TrendsTableRow } from '@components/TrendsTable';
import { siteConfig } from '@config/site';
import { publicPage } from '@lib/documents/pages';
import { pageHead } from '@lib/head';
import { analysisQuery, downloadsQuery, historyQuery, starsQuery } from '@lib/api';
import { useMeasureOnce } from '@lib/useMeasureOnce';
import { useSeriesColors } from '@lib/useSeriesColors';
import { formatCount, formatSizeText } from '@lib/format';
import {
    MAX_TREND_PACKAGES,
    SERIES_COLORS,
    groupDownloads,
    measuringText,
    packageState,
    parsePackages,
    repositoryOf,
    todayIso,
    trendsView,
    validateTrendsSearch,
    versionRows,
    weeklyDownloads,
    type TrendRow,
    type TrendsSearch,
} from '@lib/trends';

const TrendsPage = () => {
    const search = Route.useSearch();
    const navigate = useNavigate({ from: '/trends' });
    const view = useMemo(() => trendsView(search), [search]);
    const { packages, metric, range, group } = view;
    const colors = useSeriesColors(packages);
    const [chipFocus, setChipFocus] = useState<ChipFocus | undefined>(undefined);
    const clearChipFocus = useCallback(() => setChipFocus(undefined), []);

    const change = (next: TrendsSearch) => {
        void navigate({ search: (current) => validateTrendsSearch({ ...current, ...next }), resetScroll: false, replace: true });
    };
    const setPackages = useCallback(
        (names: readonly string[]) => {
            void navigate({ search: (current) => validateTrendsSearch({ ...current, packages: names.join(',') }), resetScroll: false });
        },
        [navigate],
    );
    const remove = useCallback(
        (name: string) => {
            // The button pressed goes with its chip: the keyboard moves to the chip after it, the one before it, or the field when none is left.
            const index = packages.indexOf(name);
            const rest = packages.filter((candidate) => candidate !== name);
            const next = rest[index] ?? rest[index - 1];
            setChipFocus(next === undefined ? { kind: 'search' } : { kind: 'chip', name: next });
            setPackages(rest);
        },
        [packages, setPackages],
    );
    const add = useCallback(
        (name: string) => {
            if (packages.includes(name)) return;
            const next = [...packages, name];
            // The field makes way for the last chip, so the keyboard would otherwise be left on nothing.
            if (next.length === MAX_TREND_PACKAGES) setChipFocus({ kind: 'chip', name });
            setPackages(next);
        },
        [packages, setPackages],
    );

    const analyses = useQueries({ queries: packages.map((name) => analysisQuery(name)) });
    const recentDownloads = useQueries({ queries: packages.map((name) => downloadsQuery(name, '2m')) });
    const stars = useQueries({
        queries: packages.map((_, index) => {
            const data = analyses[index]?.data;
            return starsQuery(repositoryOf(data?.status === 'done' ? data.result.repositoryUrl : undefined));
        }),
    });
    const histories = useQueries({
        queries: packages.map((name) => ({ ...historyQuery(name), enabled: metric === 'size' })),
        combine: (results) => ({ data: results.map((result) => result.data), pending: results.some((result) => result.isLoading) }),
    });
    const rangeDownloads = useQueries({
        queries: packages.map((name) => ({ ...downloadsQuery(name, range), enabled: metric === 'downloads', placeholderData: keepPreviousData })),
        combine: (results) => ({ data: results.map((result) => result.data), pending: results.some((result) => result.isLoading || result.isPlaceholderData) }),
    });

    useMeasureOnce(histories.data, metric === 'size');

    // Read once, so that the server and the browser do not disagree within one pass.
    const [now] = useState(todayIso);

    const rows = useMemo<TrendRow[]>(() => {
        if (metric === 'size') return histories.data.flatMap((history) => (history === undefined ? [] : versionRows(history.name, history.versions))).sort((a, b) => a.time - b.time);
        return rangeDownloads.data.flatMap((data) => (data === undefined ? [] : groupDownloads(data.days, group, now).map((point) => ({ name: data.name, ...point }))));
    }, [metric, group, now, histories.data, rangeDownloads.data]);

    const series = useMemo(() => packages.map((name) => ({ name, color: colors.get(name) ?? SERIES_COLORS[0] })), [packages, colors]);
    const measuring = metric === 'size' ? histories.data.reduce((sum, history) => sum + (history === undefined ? 0 : measuringCount(history)), 0) : 0;
    const metricWord = metric === 'size' ? 'Minified + gzip size of recent versions, by release date' : `Downloads per ${group}`;

    // Drawing thousands of points takes a moment too. It waits behind this render, so the mask shows first, and it is
    // only done again when what it draws has changed.
    const chart = useMemo(
        () => ({
            rows,
            series,
            releases: metric === 'size',
            until: Date.parse(now),
            formatValue: metric === 'size' ? formatSizeText : formatCount,
            ariaLabel: `${metricWord}: ${packages.join(', ')}`,
        }),
        [rows, series, metric, now, metricWord, packages],
    );
    const drawn = useDeferredValue(chart);
    const fetching = metric === 'size' ? histories.pending : rangeDownloads.pending;
    const loading = fetching || drawn !== chart;

    const tableRows = useMemo<TrendsTableRow[]>(
        () =>
            packages.map((name, index) => {
                const analysis = analyses[index];
                const data = analysis?.data;
                const result = data?.status === 'done' ? data.result : undefined;
                const days = recentDownloads[index]?.data?.days;
                return {
                    name,
                    version: data?.package.version,
                    color: colors.get(name) ?? SERIES_COLORS[0],
                    state: packageState(data, analysis?.error),
                    gzip: result?.sizes?.gzip,
                    minified: result?.sizes?.minified,
                    install: result?.install.bytes,
                    weekly: days === undefined ? undefined : weeklyDownloads(days, now),
                    stars: stars[index]?.data?.stars ?? undefined,
                    repositoryUrl: result?.repositoryUrl ?? undefined,
                };
            }),
        [packages, analyses, recentDownloads, stars, colors, now],
    );

    return (
        <main
            id={'main'}
            tabIndex={-1}
            className={'mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-10 sm:py-14'}
        >
            <div className={'flex flex-col gap-2'}>
                <h1 className={'text-title-1'}>Package trends</h1>
                <p className={'max-w-2xl text-callout text-muted-foreground'}>Compare size and downloads across up to {MAX_TREND_PACKAGES} packages.</p>
            </div>

            <PackageChips
                packages={packages}
                colors={colors}
                onRemove={remove}
                onAdd={add}
                focus={chipFocus}
                onFocused={clearChipFocus}
            />

            {packages.length === 0 ? (
                <div className={'flex flex-col items-center gap-4 py-10 text-center'}>
                    <IsoPackage className={'h-auto w-full max-w-sm'} />
                    <p className={'text-callout text-muted-foreground'}>Add a package above to start comparing.</p>
                </div>
            ) : (
                <div className={'relative flex flex-col gap-8'}>
                    {/* The controls stay live while the chart catches up: a change of metric or range must not throw the keyboard off them. */}
                    <TrendsControls
                        metric={metric}
                        range={range}
                        group={group}
                        onChange={change}
                    />

                    <div
                        inert={loading}
                        aria-busy={loading}
                        className={'flex flex-col gap-8'}
                    >
                        <section
                            aria-labelledby={'trend-title'}
                            className={'flex flex-col gap-3'}
                        >
                            <div className={'flex flex-wrap items-baseline justify-between gap-x-4'}>
                                <h2
                                    id={'trend-title'}
                                    className={'text-headline'}
                                >
                                    {metricWord}
                                </h2>
                                <p
                                    role={'status'}
                                    className={'text-caption text-muted-foreground'}
                                >
                                    {measuringText(measuring)}
                                </p>
                            </div>
                            {drawn.rows.length === 0 ? (
                                <div className={'flex h-105 items-center justify-center border-y text-callout text-muted-foreground'}>
                                    {loading || measuring > 0 ? '' : 'Nothing to show for these packages.'}
                                </div>
                            ) : (
                                <TrendsChart
                                    rows={drawn.rows}
                                    series={drawn.series}
                                    releases={drawn.releases}
                                    until={drawn.until}
                                    formatValue={drawn.formatValue}
                                    ariaLabel={drawn.ariaLabel}
                                />
                            )}
                        </section>

                        <section
                            aria-labelledby={'snapshot-title'}
                            className={'flex flex-col gap-2'}
                        >
                            <h2
                                id={'snapshot-title'}
                                className={'text-overline text-muted-foreground uppercase'}
                            >
                                Snapshot
                            </h2>
                            <TrendsTable
                                rows={tableRows}
                                onRemove={remove}
                            />
                        </section>
                    </div>
                    {loading && (
                        <div
                            role={'status'}
                            className={'trends-mask absolute inset-0 z-20 flex items-start justify-center rounded-lg pt-56'}
                        >
                            <span className={'flex items-center gap-2.5 rounded-4xl border bg-popover px-5 py-2.5 text-callout text-popover-foreground shadow-lg'}>
                                <LoaderCircle
                                    aria-hidden={'true'}
                                    className={'size-4 animate-spin text-link'}
                                />
                                Loading…
                            </span>
                        </div>
                    )}
                </div>
            )}
        </main>
    );
};

export const Route = createFileRoute('/trends')({
    validateSearch: validateTrendsSearch,
    head: ({ match }) => {
        const page = publicPage('/trends');
        const named = match.search.packages;
        const names = named === undefined ? [] : parsePackages(named);
        return pageHead({
            title: names.length > 0 ? `${names.join(' vs ')}: size and downloads` : page.title,
            description:
                names.length > 0
                    ? `Compare ${names.join(', ')}: minified and gzip size across releases, weekly downloads and GitHub stars, side by side.`
                    : (page.description ?? siteConfig.description),
            path: '/trends',
            // A comparison of any packages is a view of this one page: only the page itself is listed.
            noindex: names.length > 0,
            breadcrumbs: [
                { name: 'Home', path: '/' },
                { name: 'Trends', path: '/trends' },
            ],
            // A page of comparisons, not one thing: the packages compared are chosen by whoever opens it.
            page: { '@type': 'CollectionPage' },
        });
    },
    component: TrendsPage,
});
