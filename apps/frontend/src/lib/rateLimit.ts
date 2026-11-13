/**
 * A fixed-window counter per key (a visitor's address): `take(key)` is true while the key has asked at most `limit`
 * times in the current window. Every window starts empty, so memory never holds more than one window's keys; past
 * `maxKeys` different keys in one window, the newcomers share one count, so a flood of addresses cannot grow it either.
 * That count is `overflowKeys` keys' worth: it bounds memory, and with one key's share whoever filled the map would
 * leave every new visitor a single share between them.
 */
export const fixedWindowLimiter = (options: { limit: number; windowMs: number; maxKeys?: number; overflowKeys?: number }) => {
    const maxKeys = options.maxKeys ?? 10_000;
    const overflowLimit = options.limit * (options.overflowKeys ?? 50);
    let windowStart = Number.NEGATIVE_INFINITY;
    const counts = new Map<string, number>();
    return {
        take: (key: string, now = Date.now()): boolean => {
            if (now - windowStart >= options.windowMs) {
                counts.clear();
                windowStart = now;
            }
            const bucket = counts.has(key) || counts.size < maxKeys ? key : '*';
            const count = (counts.get(bucket) ?? 0) + 1;
            counts.set(bucket, count);
            return count <= (bucket === '*' && key !== '*' ? overflowLimit : options.limit);
        },
    };
};

/**
 * A small cache of answers that stay true for a while (`ttlMs`), the oldest dropped past `max` entries. A value being
 * made is shared by everyone who asks for it meanwhile; a failure is not kept.
 */
export const ttlCache = <T>(options: { ttlMs: number; max: number }) => {
    const entries = new Map<string, { value: Promise<T>; expires: number }>();
    return {
        get: (key: string, make: () => Promise<T>, now = Date.now()): Promise<T> => {
            const hit = entries.get(key);
            if (hit !== undefined && hit.expires > now) return hit.value;
            entries.delete(key);
            const value = make();
            entries.set(key, { value, expires: now + options.ttlMs });
            value.catch(() => {
                if (entries.get(key)?.value === value) entries.delete(key);
            });
            while (entries.size > options.max) entries.delete(entries.keys().next().value ?? key);
            return value;
        },
    };
};
