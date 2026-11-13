import { describe, expect, it } from 'vitest';
import { AnalysisError, toFailure } from '@modules/analysis/failure.ts';

describe('what a failure says outside', () => {
    it("leaves out the code a tool quotes, the colors and this machine's paths", () => {
        const quoted = [
            'Build failed with 1 error:',
            '',
            '\u001b[31m[PARSE_ERROR] \u001b[0mUnexpected token',
            '   \u001b[38;5;246m╭─[\u001b[0m /work/jobs/1/node_modules/example/index.js:1:15 ]',
            '   │',
            ' 1 │ SECRET=do-not-show',
            '   │               ┬',
            '   │               ╰── here',
            '───╯',
        ].join('\n');
        const failure = toFailure(new AnalysisError('BUNDLE_FAILED', quoted), ['/work/jobs/1']);
        expect(failure.code).toBe('BUNDLE_FAILED');
        expect(failure.message).toBe('Build failed with 1 error:\n\n[PARSE_ERROR] Unexpected token');
    });

    it('caps the length, and says something when nothing is left', () => {
        expect(toFailure(new Error('x'.repeat(2000)), []).message).toHaveLength(500);
        expect(toFailure(new Error(' │ only a frame'), [])).toEqual({ code: 'INTERNAL', message: 'The analysis failed' });
    });
});
