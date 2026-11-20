import { isMadeForNode, type AnalysisResult } from '@weighme/core';
import { Link } from '@tanstack/react-router';
import { FigureBand } from '@components/FigureBand';
import { Notice } from '@components/Notice';
import { formatDownloadTimes, formatSize, formatSizeText } from '@lib/format';

const MAX_BUILTINS_NAMED = 5;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** Says when the size is not what the package costs in a browser: what it needs from Node.js or could not find is not in the number. */
const environmentNote = (environment: AnalysisResult['environment']): string | undefined => {
    const { nodeBuiltins, nativeAddons, unresolvedImports } = environment;
    const needs: string[] = [];
    if (nodeBuiltins.length > 0) {
        const named = nodeBuiltins.slice(0, MAX_BUILTINS_NAMED).join(', ');
        const more = nodeBuiltins.length - MAX_BUILTINS_NAMED;
        needs.push(`Node.js modules (${more > 0 ? `${named} and ${more} more` : named})`);
    }
    if (nativeAddons > 0) needs.push(plural(nativeAddons, 'native addon', 'native addons'));
    const madeForNode =
        needs.length > 0
            ? `This package is made for Node.js, not the browser: it uses ${needs.join(' and ')}. The size shows what a bundler pulls in from its main entry, not what it costs in a web page.`
            : '';
    const missing = unresolvedImports > 0 ? `${plural(unresolvedImports, 'import', 'imports')} could not be found, often optional ones, so the real size may be larger.` : '';
    const note = `${madeForNode} ${missing}`.trim();
    return note === '' ? undefined : note;
};

type NothingToImportProps = { result: AnalysisResult };

/** A package with nothing to import, such as a command-line tool: it adds nothing to a bundle, so what it costs is its install. */
const NothingToImport = (props: NothingToImportProps) => {
    const size = formatSize(props.result.install.bytes);
    const { commands, install } = props.result;
    return (
        <div className={'flex flex-col gap-8'}>
            <div className={'flex flex-col gap-1'}>
                <p className={'text-overline text-muted-foreground uppercase'}>Install size</p>
                <p className={'text-score tabular-nums'}>
                    {size.value}
                    <span className={'ml-3 text-title-1 text-muted-foreground'}>{size.unit}</span>
                </p>
                <p className={'text-callout text-muted-foreground'}>On disk, {install.packages === 1 ? 'with no dependencies' : `with its dependencies: ${install.packages} packages`}.</p>
            </div>
            <Notice>
                {commands.length > 0
                    ? `This is a command-line tool, run as ${commands.join(', ')}. It has nothing to import, so it adds nothing to your bundle.`
                    : 'This package has no entry that can be imported, so there is no bundle to measure.'}
            </Notice>
        </div>
    );
};

type SizeResultProps = { result: AnalysisResult };

/** The number people came for first (what goes over the wire), then the rest in one ruled band, then how it was measured. */
export const SizeResult = (props: SizeResultProps) => {
    const { bundler, environment, install, peerDependencies, sizes } = props.result;
    if (sizes === null) return <NothingToImport result={props.result} />;
    const gzip = formatSize(sizes.gzip);
    const note = environmentNote(environment);
    // A package made for Node.js is not downloaded by a browser, so a time for it would mislead.
    const madeForNode = isMadeForNode(environment);

    return (
        <div className={'flex flex-col gap-8'}>
            <div className={'flex flex-col gap-1'}>
                <p className={'text-overline text-muted-foreground uppercase'}>Minified + gzip</p>
                <p className={'text-score tabular-nums'}>
                    {gzip.value}
                    <span className={'ml-3 text-title-1 text-muted-foreground'}>{gzip.unit}</span>
                </p>
                {!madeForNode && (
                    <p className={'text-callout text-muted-foreground'}>
                        Downloads in {formatDownloadTimes(sizes.gzip)}.{' '}
                        <Link
                            to={'/about'}
                            hash={'download-time'}
                            className={'text-link underline-offset-2 hover:underline'}
                        >
                            How this is worked out
                        </Link>
                    </p>
                )}
            </div>
            {note !== undefined && <Notice>{note}</Notice>}
            <FigureBand
                items={[
                    { label: 'Minified', value: formatSizeText(sizes.minified), hint: 'before compression' },
                    { label: 'Brotli', value: formatSizeText(sizes.brotli), hint: 'at the highest quality' },
                    { label: 'Install size', value: formatSizeText(install.bytes), hint: 'on disk, with dependencies' },
                    { label: 'Packages', value: String(install.packages), hint: install.packages === 1 ? 'no dependencies' : 'with its dependencies' },
                ]}
            />
            <p className={'text-callout text-muted-foreground'}>
                Measured with {bundler.name} {bundler.version}.{' '}
                {peerDependencies.length > 0 ? `Peer dependencies are not included: ${peerDependencies.join(', ')}.` : 'The package has no peer dependencies.'} Another bundler can give a different
                number.
            </p>
        </div>
    );
};
