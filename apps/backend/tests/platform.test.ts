import { describe, expect, it } from 'vitest';
import { loadConfig } from '@config/env.ts';
import { clientKey } from '@platform/http/client-key.ts';
import { createLogger } from '@platform/logger.ts';
import { createRateLimiter } from '@platform/rate-limit.ts';

const capture = () => {
    const lines: string[] = [];
    return { lines, stream: { write: (line: string) => void lines.push(line) } };
};

describe('the logger', () => {
    it('writes JSON with the level as a word and the service name', () => {
        const { lines, stream } = capture();
        createLogger({ LOG_LEVEL: 'info' }, stream).info({ requestId: 'abc' }, 'hello');
        expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ level: 'info', service: 'api', msg: 'hello', requestId: 'abc' });
    });

    it('redacts secrets by path', () => {
        const { lines, stream } = capture();
        createLogger({ LOG_LEVEL: 'info' }, stream).info(
            { req: { headers: { authorization: 'Bearer secret', cookie: 'sid=1' } }, headers: { authorization: 'Bearer other' }, github: { token: 'ghp_x', apiKey: 'sk-live', password: 'p' } },
            'x',
        );
        const text = lines[0] ?? '';
        for (const secret of ['Bearer secret', 'sid=1', 'Bearer other', 'ghp_x', 'sk-live', '"p"']) expect(text).not.toContain(secret);
        expect(text).toContain('[redacted]');
    });

    it('stays silent at the silent level', () => {
        const { lines, stream } = capture();
        createLogger({ LOG_LEVEL: 'silent' }, stream).error('nothing');
        expect(lines).toEqual([]);
    });
});

describe('rate limiter', () => {
    it('allows the limit per window, then refuses until the window ends', () => {
        let now = 0;
        const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => now });
        expect([limiter.hit('a').allowed, limiter.hit('a').allowed, limiter.hit('a').allowed]).toEqual([true, true, false]);
        expect(limiter.hit('b').allowed).toBe(true);
        expect(limiter.hit('a').resetSeconds).toBe(60);
        now = 60_000;
        expect(limiter.hit('a')).toMatchObject({ allowed: true, remaining: 1 });
    });

    it('holds at most maxKeys callers apart; the rest share one count', () => {
        const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 2, overflowCallers: 1, now: () => 0 });
        expect(limiter.hit('a').allowed).toBe(true);
        expect(limiter.hit('b').allowed).toBe(true);
        // A third and a fourth caller are one to the limiter: the second of them is already past the shared count.
        expect(limiter.hit('c').allowed).toBe(true);
        expect(limiter.hit('d').allowed).toBe(true);
        expect(limiter.hit('e').allowed).toBe(false);
        // Callers it knows keep their own count.
        expect(limiter.hit('a').allowed).toBe(true);
    });

    it("gives the newcomers past maxKeys many callers' worth between them, so that a full map does not shut new visitors out", () => {
        const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 1, overflowCallers: 3, now: () => 0 });
        expect(limiter.hit('a').allowed).toBe(true);
        expect(['b', 'c', 'd', 'e'].map((caller) => limiter.hit(caller).allowed)).toEqual([true, true, true, false]);
        // What it reports stays one caller's share, never the shared one.
        expect(limiter.hit('f')).toMatchObject({ limit: 1, remaining: 0 });
        expect(limiter.hit('a').allowed).toBe(false);
    });

    it('sweeps a full map before turning a newcomer to the shared count', () => {
        let now = 0;
        const limiter = createRateLimiter({ limit: 1, windowMs: 10_000, maxKeys: 2, overflowCallers: 1, now: () => now });
        now = 10_000;
        limiter.hit('early');
        now = 16_000;
        expect([limiter.hit('a').allowed, limiter.hit('b').allowed]).toEqual([true, true]);
        // Every window has ended, and the regular sweep is not due until 30 000: without one now, `c` and `d` would
        // share a single count.
        now = 26_000;
        expect([limiter.hit('c').allowed, limiter.hit('d').allowed]).toEqual([true, true]);
    });

    it('forgets windows that ended', () => {
        let now = 0;
        const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 1, now: () => now });
        expect(limiter.hit('a').allowed).toBe(true);
        expect(limiter.hit('b').allowed).toBe(true);
        now = 1000;
        // The sweep made room: `c` is counted apart, not as the shared newcomer.
        expect(limiter.hit('c').allowed).toBe(true);
        expect(limiter.hit('d').allowed).toBe(true);
    });
});

describe('the caller key', () => {
    it('takes one valid address from the header, else the connection', () => {
        expect(clientKey('203.0.113.7', '10.0.0.1')).toBe('203.0.113.7');
        expect(clientKey(' 203.0.113.7 ', '10.0.0.1')).toBe('203.0.113.7');
        for (const value of ['203.0.113.7, 10.0.0.1', 'evil.example', '', undefined]) expect(clientKey(value, '10.0.0.1')).toBe('10.0.0.1');
        expect(clientKey(undefined, undefined)).toBe('unknown');
    });

    it('counts IPv6 callers by their /64 and strips the IPv4-mapped prefix', () => {
        // Any spelling of one block gives one key, in the shortest form, as cve-tracker writes it.
        expect(clientKey(undefined, '2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
        expect(clientKey(undefined, '2001:db8:1:2:aaaa::1')).toBe(clientKey(undefined, '2001:0db8:0001:0002:bbbb::9'));
        expect(clientKey(undefined, '2001:db8::1')).toBe('2001:db8::/64');
        expect(clientKey(undefined, 'fe80::1%eth0')).toBe('fe80::/64');
        expect(clientKey(undefined, '::ffff:203.0.113.7')).toBe('203.0.113.7');
        expect(clientKey(undefined, '64:ff9b::203.0.113.7')).toBe('64:ff9b::/64');
    });
});

describe('the configuration', () => {
    const base = { WORKER_TOKEN: 'x'.repeat(32) };

    it('refuses a chain header for the caller address, and takes a blank as unset', () => {
        expect(loadConfig({ ...base, CLIENT_IP_HEADER: 'X-Forwarded-For' })).toMatchObject({ ok: false });
        const loaded = loadConfig({ ...base, CLIENT_IP_HEADER: ' CF-Connecting-IP ', INTERNAL_API_TOKEN: '' });
        expect(loaded.ok && loaded.config.CLIENT_IP_HEADER).toBe('cf-connecting-ip');
        expect(loaded.ok && loaded.config.INTERNAL_API_TOKEN).toBeUndefined();
        expect(loadConfig({ ...base, INTERNAL_API_TOKEN: 'short' })).toMatchObject({ ok: false });
    });

    it('takes a blank value for any key as unset, as Compose writes one for a variable nobody set', () => {
        const loaded = loadConfig({ ...base, GITHUB_TOKEN: '', PORT: '  ', LOG_LEVEL: '', CORS_ORIGINS: '', DATABASE_PATH: undefined });
        expect(loaded.ok).toBe(true);
        if (!loaded.ok) return;
        expect(loaded.config.GITHUB_TOKEN).toBeUndefined();
        expect(loaded.config).toMatchObject({ PORT: 4100, LOG_LEVEL: 'info', CORS_ORIGINS: [], DATABASE_PATH: './data/weighme.db' });
        // A blank required value is still missing.
        expect(loadConfig({ WORKER_TOKEN: '' })).toMatchObject({ ok: false });
    });

    it('refuses the public example tokens in production', () => {
        const production = {
            NODE_ENV: 'production',
            CORS_ORIGINS: 'https://example.com',
            WORKER_TOKEN: 'local-development-only-not-a-secret',
            INTERNAL_API_TOKEN: 'local-development-only-render-token-not-a-secret',
        };
        const loaded = loadConfig(production);
        expect(!loaded.ok && loaded.problems).toEqual(expect.arrayContaining([expect.stringContaining('WORKER_TOKEN'), expect.stringContaining('INTERNAL_API_TOKEN')]));
    });
});
