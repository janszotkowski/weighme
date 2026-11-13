export type RateLimitResult = { allowed: boolean; limit: number; remaining: number; resetSeconds: number };

/** Distinct callers counted apart in one window; past it, newcomers share one count, so a flood of addresses cannot grow the map. */
const MAX_KEYS = 10_000;

/**
 * How many callers' worth of requests the newcomers past `maxKeys` share. The shared count is there to bound memory, not
 * to hold visitors back: with one caller's share, whoever filled the map with addresses would leave every new visitor a
 * single share between them.
 */
const OVERFLOW_CALLERS = 50;

const FULL_SWEEP_MS = 1000;

/**
 * A fixed-window request counter per caller: `limit` requests per `windowMs`. In memory, which is right for the one API
 * process this service runs; windows that ended are swept so the map does not grow with every address seen, and it holds
 * at most `maxKeys` callers at once.
 */
export const createRateLimiter = (options: { limit: number; windowMs: number; maxKeys?: number; overflowCallers?: number; now?: () => number }) => {
    const now = options.now ?? Date.now;
    const maxKeys = options.maxKeys ?? MAX_KEYS;
    const overflowLimit = options.limit * (options.overflowCallers ?? OVERFLOW_CALLERS);
    const windows = new Map<string, { start: number; count: number }>();
    let lastSweep = now();

    const sweep = (time: number): void => {
        lastSweep = time;
        for (const [key, window] of windows) if (time - window.start >= options.windowMs) windows.delete(key);
    };

    return {
        hit: (caller: string): RateLimitResult => {
            const time = now();
            if (time - lastSweep >= options.windowMs) sweep(time);
            // A full map is swept before a newcomer is turned to the shared count: windows that ended may be most of it.
            // Once a second at most, or a flood of newcomers would have the whole map walked for each of them.
            if (!windows.has(caller) && windows.size >= maxKeys && time - lastSweep >= FULL_SWEEP_MS) sweep(time);
            // One more caller than the map holds: counted with every other newcomer, never left out.
            const key = windows.has(caller) || windows.size < maxKeys ? caller : '*';
            const limit = key === '*' && caller !== '*' ? overflowLimit : options.limit;
            let window = windows.get(key);
            if (window === undefined || time - window.start >= options.windowMs) {
                window = { start: time, count: 0 };
                windows.set(key, window);
            }
            window.count++;
            return {
                allowed: window.count <= limit,
                limit: options.limit,
                remaining: Math.max(0, Math.min(options.limit, limit - window.count)),
                resetSeconds: Math.max(1, Math.ceil((window.start + options.windowMs - time) / 1000)),
            };
        },
    };
};

export type RateLimiter = ReturnType<typeof createRateLimiter>;
