import { describe, expect, it } from 'vitest';
import { createBackendClient } from '@modules/backend/client.ts';

const CONFIG = { BACKEND_URL: 'http://backend.test', WORKER_TOKEN: 'x'.repeat(32) };

/** A backend that answers every request with the same body, and remembers what it was asked. */
const backendAnswering = (body: unknown, status = 200) => {
    const asked: { url: string; authorization: string | null; body: unknown }[] = [];
    const request: typeof fetch = async (input, init) => {
        const sent = new Request(input, init);
        const text = await sent.text();
        asked.push({ url: sent.url, authorization: sent.headers.get('authorization'), body: text === '' ? undefined : JSON.parse(text) });
        return Response.json(body, { status });
    };
    return { asked, client: createBackendClient(CONFIG, request) };
};

describe('the worker asking the backend', () => {
    it('claims a job with its token', async () => {
        const job = { id: 7, package: { name: 'example', version: '1.0.0' } };
        const { asked, client } = backendAnswering({ job });
        expect(await client.claim()).toEqual(job);
        expect(asked).toEqual([{ url: 'http://backend.test/internal/jobs/claim', authorization: `Bearer ${CONFIG.WORKER_TOKEN}`, body: undefined }]);
    });

    it('has nothing to do when the queue is empty', async () => {
        expect(await backendAnswering({ job: null }).client.claim()).toBeUndefined();
    });

    it('does not take a package name or a version on trust', async () => {
        await expect(backendAnswering({ job: { id: 1, package: { name: '../etc', version: '1.0.0' } } }).client.claim()).rejects.toThrow('invalid package');
        await expect(backendAnswering({ job: { id: 1, package: { name: 'example', version: 'latest' } } }).client.claim()).rejects.toThrow('invalid package');
    });

    it('hands in each kind of answer at its own path', async () => {
        const { asked, client } = backendAnswering({ accepted: true });
        const failure = { code: 'TIMEOUT' as const, message: 'Too slow' };
        expect(await client.fail(3, failure)).toBe(true);
        expect(await client.failExports(3)).toBe(true);
        expect(asked.map(({ url, body }) => ({ url, body }))).toEqual([
            { url: 'http://backend.test/internal/jobs/3/failure', body: failure },
            { url: 'http://backend.test/internal/jobs/3/exports-failure', body: undefined },
        ]);
    });

    it('says when the backend took an answer too late', async () => {
        expect(await backendAnswering({ accepted: false }).client.failExports(3)).toBe(false);
    });
});
