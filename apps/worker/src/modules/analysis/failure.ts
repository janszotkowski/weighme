import type { AnalysisFailure } from '@weighme/core';

/** A failure with a code the backend stores and the page explains. */
export class AnalysisError extends Error {
    readonly code: AnalysisFailure['code'];

    constructor(code: AnalysisFailure['code'], message: string) {
        super(message);
        this.name = 'AnalysisError';
        this.code = code;
    }
}

/** The package has nothing that can be imported, such as a command-line tool. That is an answer, not a failure. */
export class NoEntryError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NoEntryError';
    }
}

const MAX_MESSAGE = 500;

// oxlint-disable-next-line no-control-regex -- terminal colors are exactly what this removes.
const TERMINAL_CODES = /\u001b\[[0-9;]*[A-Za-z]/g;

/** A line of the frame a tool draws around the code it complains about: the box's edges, and the numbered lines of the file itself. */
const CODE_FRAME = /^\s*(?:\d+\s*)?[│╭╰├─┬·].*$\n?/gm;

/**
 * What leaves this machine: terminal colors and local paths (the job's folder, the shared store) are removed and the
 * length is capped, since tools color their errors and name files in them. The code they quote is removed too: the
 * message ends up on a public page, and what a tool quotes is whatever file a package made it read.
 * `/private` is where macOS really keeps `/var`.
 */
export const toFailure = (error: unknown, localPaths: readonly string[]): AnalysisFailure => {
    let message = (error instanceof Error ? error.message : String(error)).replace(TERMINAL_CODES, '').replace(CODE_FRAME, '');
    for (const path of localPaths) message = message.replaceAll(`/private${path}/`, '').replaceAll(`${path}/`, '').replaceAll(path, '');
    message = message.trim().slice(0, MAX_MESSAGE);
    return { code: error instanceof AnalysisError ? error.code : 'INTERNAL', message: message === '' ? 'The analysis failed' : message };
};

/** The bundle holds nothing of the package: for an ES module, an entry that exports nothing; for CommonJS, something gone wrong. */
export class EmptyEntryError extends AnalysisError {
    constructor(message: string) {
        super('BUNDLE_FAILED', message);
        this.name = 'EmptyEntryError';
    }
}
