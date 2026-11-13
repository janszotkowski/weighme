import { afterEach, describe, expect, it, vi } from 'vitest';
import { FULL_DOCUMENT_MAX_BYTES, MAX_BODY_BYTES, createDownloadsReader, createVersionLister, resolveFromRegistry } from '@modules/analyses/infrastructure/registry.ts';

afterEach(() => {
    vi.unstubAllGlobals();
});

const DOCUMENT = { 'dist-tags': { latest: '2.0.0' }, versions: { '1.0.0': {}, '2.0.0': {} }, time: { '1.0.0': '2024-01-01T00:00:00.000Z', '2.0.0': '2025-01-01T00:00:00.000Z' } };

describe('the registry readers', () => {
    it('read the full document once for a burst of questions about one package, and again after a while', async () => {
        let time = 0;
        const fetchMock = vi.fn(async () => Response.json(DOCUMENT));
        vi.stubGlobal('fetch', fetchMock);
        const list = createVersionLister(() => time);
        const answers = await Promise.all([list('example'), list('example'), list('example')]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(answers[0]).toEqual([
            { version: '2.0.0', publishedAt: '2025-01-01T00:00:00.000Z' },
            { version: '1.0.0', publishedAt: '2024-01-01T00:00:00.000Z' },
        ]);
        await list('other');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        time = 11 * 60_000;
        await list('example');
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('keep the failure of a full document for a while: asking again would read it all again', async () => {
        let time = 0;
        const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
        vi.stubGlobal('fetch', fetchMock);
        const list = createVersionLister(() => time);
        await expect(list('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(list('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        time = 60_000;
        await expect(list('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('read few full documents at a time, and refuse at once when too many already wait', async () => {
        const answers: (() => void)[] = [];
        const fetchMock = vi.fn(() => new Promise<Response>((resolve) => answers.push(() => resolve(Response.json(DOCUMENT)))));
        vi.stubGlobal('fetch', fetchMock);
        const list = createVersionLister();
        // Two are read and eight wait; the eleventh is told to come back, and is not remembered as a failure of its package.
        const asked = Array.from({ length: 10 }, (_, index) => list(`package-${index}`));
        await expect(list('one-too-many')).rejects.toMatchObject({ code: 'UNAVAILABLE', message: expect.stringContaining('Too many') });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        while (answers.length > 0 || fetchMock.mock.calls.length < 10) {
            answers.shift()?.();
            await new Promise((resolve) => setImmediate(resolve));
        }
        expect((await Promise.all(asked)).every((versions) => versions.length === 2)).toBe(true);
        answers.length = 0;
        const again = list('one-too-many');
        await new Promise((resolve) => setImmediate(resolve));
        answers.shift()?.();
        expect(await again).toHaveLength(2);
    });

    it('do not keep a failure, and say what went wrong', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response('', { status: 404 }))
            .mockResolvedValueOnce(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))
            .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
            .mockResolvedValueOnce(Response.json({ version: '1.2.3' }));
        vi.stubGlobal('fetch', fetchMock);
        await expect(resolveFromRegistry('example', 'latest')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(resolveFromRegistry('example', 'latest')).rejects.toMatchObject({ code: 'UNAVAILABLE', message: expect.stringContaining('unexpected') });
        await expect(resolveFromRegistry('example', 'latest')).rejects.toMatchObject({ code: 'UNAVAILABLE', message: expect.stringContaining('did not answer') });
        expect(await resolveFromRegistry('example', 'latest')).toBe('1.2.3');
    });

    it('give up on an answer past the byte cap instead of holding it whole', async () => {
        let cancelled = false;
        let pulls = 0;
        // A body that never ends: a megabyte on every pull until the reader gives up.
        const endless = new ReadableStream<Uint8Array>({
            pull: (controller) => {
                pulls++;
                controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
            },
            cancel: () => {
                cancelled = true;
            },
        });
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response(endless, { status: 200 }))
            .mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }))
            .mockResolvedValueOnce(Response.json({ version: '1.2.3' }));
        vi.stubGlobal('fetch', fetchMock);
        await expect(resolveFromRegistry('example', 'latest')).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'The npm registry sent too much data' });
        expect(cancelled).toBe(true);
        expect(pulls).toBeLessThanOrEqual(MAX_BODY_BYTES / (1024 * 1024) + 2);
        // A declared length past the cap is refused before a byte is read.
        await expect(resolveFromRegistry('example', 'latest')).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'The npm registry sent too much data' });
        // A document under the cap is read as before.
        expect(await resolveFromRegistry('example', 'latest')).toBe('1.2.3');
        expect(FULL_DOCUMENT_MAX_BYTES).toBeGreaterThan(MAX_BODY_BYTES);
    });

    it('take a 404 for downloads as none, not as a failure', async () => {
        const fetchMock = vi.fn(async (url: string | URL | Request) =>
            String(url).includes('2024') ? new Response('', { status: 404 }) : Response.json({ downloads: [{ day: '2025-06-01', downloads: 5 }] }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const read = createDownloadsReader(() => Date.UTC(2025, 5, 2));
        expect(await read('example', '2m')).toEqual([{ day: '2025-06-01', downloads: 5 }]);
    });
});
