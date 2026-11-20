import type { AnalysisFailure, AnalysisResponse, AnalysisResult, ExportsState } from './contract/analysis.ts';

/**
 * A package made for Node.js: it needs Node's own modules or a native addon, none of which is in the sizes. A browser
 * does not download it, so its size is not what it costs in a web page, and a download time for it would mislead.
 */
export const isMadeForNode = (environment: AnalysisResult['environment']): boolean => environment.nodeBuiltins.length > 0 || environment.nativeAddons > 0;

/**
 * What an analysis says to whoever reads it, whatever it is shown in: still being measured, failed, measured with
 * nothing to import (a command-line tool: there is no bundle, so what it costs is its install), or measured with sizes.
 */
export type AnalysisFacts =
    | { state: 'measuring' }
    | { state: 'failed'; failure: AnalysisFailure }
    | { state: 'nothing-to-import'; result: AnalysisResult; exports: ExportsState; madeForNode: boolean }
    | { state: 'measured'; result: AnalysisResult; exports: ExportsState; sizes: NonNullable<AnalysisResult['sizes']>; madeForNode: boolean };

/** The facts every way of showing an analysis starts from: the page, the Markdown document, the badge and the terminal word them, and none works them out again. */
export const analysisFacts = (answer: AnalysisResponse): AnalysisFacts => {
    if (answer.status === 'queued' || answer.status === 'running') return { state: 'measuring' };
    if (answer.status === 'failed') return { state: 'failed', failure: answer.failure };
    const { result, exports } = answer;
    const madeForNode = isMadeForNode(result.environment);
    return result.sizes === null ? { state: 'nothing-to-import', result, exports, madeForNode } : { state: 'measured', result, exports, sizes: result.sizes, madeForNode };
};
