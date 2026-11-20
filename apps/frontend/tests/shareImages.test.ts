import { describe, expect, it, vi } from 'vitest';
import { ShareImageBusy, createShareImages } from '@lib/documents/shareImages';

const bytes = (value: number): Uint8Array => new Uint8Array([value]);

/** A drawing the test finishes when it chooses. */
const held = () => {
    let finish: (value: Uint8Array) => void = () => undefined;
    const draw = vi.fn(() => new Promise<Uint8Array>((resolve) => (finish = resolve)));
    return { draw, finish: (value: number) => finish(bytes(value)) };
};

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('share images', () => {
    it('draws an image once and keeps it', async () => {
        const images = createShareImages({ cacheMax: 10, drawingMax: 2, waitingMax: 20 });
        const draw = vi.fn(async () => bytes(1));
        expect(await images.get('a', draw)).toEqual(bytes(1));
        expect(await images.get('a', draw)).toEqual(bytes(1));
        expect(draw).toHaveBeenCalledTimes(1);
    });

    it('has everyone asking for an image being drawn wait for that drawing', async () => {
        const images = createShareImages({ cacheMax: 10, drawingMax: 2, waitingMax: 20 });
        const { draw, finish } = held();
        const both = Promise.all([images.get('a', draw), images.get('a', draw)]);
        await settled();
        finish(7);
        expect(await both).toEqual([bytes(7), bytes(7)]);
        expect(draw).toHaveBeenCalledTimes(1);
    });

    it('drops the least recently used image past its size', async () => {
        const images = createShareImages({ cacheMax: 2, drawingMax: 2, waitingMax: 20 });
        const draw = vi.fn(async () => bytes(1));
        await images.get('a', draw);
        await images.get('b', draw);
        await images.get('a', draw);
        await images.get('c', draw);
        draw.mockClear();
        await images.get('a', draw);
        expect(draw).not.toHaveBeenCalled();
        await images.get('b', draw);
        expect(draw).toHaveBeenCalledTimes(1);
    });

    it('draws only a few at a time, and refuses when too many wait', async () => {
        const images = createShareImages({ cacheMax: 10, drawingMax: 1, waitingMax: 1 });
        const first = held();
        const second = held();
        const drawingFirst = images.get('a', first.draw);
        const waitingSecond = images.get('b', second.draw);
        await settled();
        expect(second.draw).not.toHaveBeenCalled();
        await expect(images.get('c', async () => bytes(3))).rejects.toBeInstanceOf(ShareImageBusy);
        first.finish(1);
        await drawingFirst;
        await settled();
        expect(second.draw).toHaveBeenCalledTimes(1);
        second.finish(2);
        expect(await waitingSecond).toEqual(bytes(2));
    });

    it('does not keep a drawing that failed', async () => {
        const images = createShareImages({ cacheMax: 10, drawingMax: 2, waitingMax: 20 });
        await expect(images.get('a', () => Promise.reject(new Error('no font')))).rejects.toThrow('no font');
        expect(await images.get('a', async () => bytes(1))).toEqual(bytes(1));
    });
});
