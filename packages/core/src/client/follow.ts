import { isComplete, type AnalysisResponse } from '../contract/analysis.ts';

/** While a package is queued or running its sizes can arrive any second; the part-by-part numbers take longer, and the sizes are already there to show. */
const SIZES_POLL_MS = 1000;
const PARTS_POLL_MS = 2000;

/**
 * The spec to ask for a package's analysis with. Once an answer has named the exact version, only that version is asked
 * for: a tag would have the backend ask the registry on every poll.
 */
export const specToAsk = (spec: string, last: AnalysisResponse | undefined): string => (last === undefined ? spec : `${last.package.name}@${last.package.version}`);

/** What an analysis still owes, and how soon to ask for it again. */
export type AskAgain = { awaiting: 'sizes' | 'parts'; afterMs: number };

/**
 * Whether an answer is worth asking for again: not when it failed or everything has arrived, the part-by-part numbers
 * included. Whoever needs the sizes alone stops once only the parts are awaited.
 */
export const askAgain = (answer: AnalysisResponse): AskAgain | undefined => {
    if (answer.status === 'failed' || isComplete(answer)) return undefined;
    return answer.status === 'done' ? { awaiting: 'parts', afterMs: PARTS_POLL_MS } : { awaiting: 'sizes', afterMs: SIZES_POLL_MS };
};
