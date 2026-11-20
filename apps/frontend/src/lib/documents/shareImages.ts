/** Too many share images are waiting to be drawn: whoever asked gets something else instead. */
export class ShareImageBusy extends Error {}

/**
 * Share images: drawing one takes far longer than answering and blocks the server while it runs, and a shared link is
 * fetched by every app it is pasted into, often at once. So drawn images are kept (the least recently used go first),
 * requests for an image being drawn wait for that drawing, and only a few are drawn at a time; when too many wait, the
 * request is refused with `ShareImageBusy`.
 */
export const createShareImages = (options: { cacheMax: number; drawingMax: number; waitingMax: number }) => {
    const images = new Map<string, Uint8Array<ArrayBuffer>>();
    const drawing = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
    let running = 0;
    const waiting: (() => void)[] = [];

    return {
        get: (key: string, draw: () => Promise<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> => {
            const cached = images.get(key);
            if (cached !== undefined) {
                images.delete(key);
                images.set(key, cached);
                return Promise.resolve(cached);
            }
            const underWay = drawing.get(key);
            if (underWay !== undefined) return underWay;
            const promise = (async () => {
                if (running >= options.drawingMax) {
                    if (waiting.length >= options.waitingMax) throw new ShareImageBusy('too many share images are being drawn');
                    await new Promise<void>((resolve) => waiting.push(resolve));
                }
                running++;
                try {
                    const bytes = new Uint8Array(await draw());
                    images.set(key, bytes);
                    if (images.size > options.cacheMax) images.delete(images.keys().next().value ?? key);
                    return bytes;
                } finally {
                    running--;
                    waiting.shift()?.();
                }
            })();
            drawing.set(key, promise);
            void promise.finally(() => drawing.delete(key)).catch(() => undefined);
            return promise;
        },
    };
};
