import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiBaseUrl, API_URL, internalApiHeaders } from '@config/api';
import { clientIpHeader, parseIp, requestIp } from '@lib/clientIp';
import { fixedWindowLimiter, ttlCache } from '@lib/rateLimit';
import { VISITOR_STORE_KEY } from '@lib/visitor';

/** A request as the Node server hands it over: the connection's address on `ip`. */
const request = (headers: Record<string, string>, ip = '198.51.100.9') => Object.assign(new Request('http://localhost/', { headers }), { ip });

afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as Record<symbol, unknown>)[VISITOR_STORE_KEY];
});

describe('the visitor address', () => {
    it('takes one valid address from the configured header', () => {
        expect(requestIp(request({ 'cf-connecting-ip': '203.0.113.7' }), 'cf-connecting-ip')).toBe('203.0.113.7');
        expect(requestIp(request({ 'x-real-ip': ' 2001:db8::1 ' }), 'x-real-ip')).toBe('2001:db8::1');
        expect(requestIp(request({ 'x-real-ip': '[2001:db8::1]:443' }), 'x-real-ip')).toBe('2001:db8::1');
        expect(requestIp(request({ 'x-real-ip': '203.0.113.7:8080' }), 'x-real-ip')).toBe('203.0.113.7');
    });

    it('falls back to the connection for a header that is not one address', () => {
        for (const value of ['203.0.113.7, 10.0.0.1', 'evil.example', 'not an ip', '999.1.1.1', '']) {
            expect(requestIp(request({ 'x-real-ip': value }), 'x-real-ip')).toBe('198.51.100.9');
        }
        expect(requestIp(request({}), 'x-real-ip')).toBe('198.51.100.9');
        expect(requestIp(request({ 'x-real-ip': '203.0.113.7' }), undefined)).toBe('198.51.100.9');
        expect(requestIp(new Request('http://localhost/'), undefined)).toBeUndefined();
        expect(parseIp('[203.0.113.7]')).toBeUndefined();
    });

    it('says once, in production only, when no request names its visitor', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(requestIp(new Request('http://localhost/'), undefined, false)).toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
        expect(requestIp(new Request('http://localhost/'), undefined, true)).toBeUndefined();
        expect(requestIp(new Request('http://localhost/'), 'x-real-ip', true)).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain('CLIENT_IP_HEADER');
        warn.mockRestore();
    });

    it('refuses chain headers the client can write', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(clientIpHeader('X-Forwarded-For')).toBeUndefined();
        expect(clientIpHeader('forwarded')).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(2);
        warn.mockRestore();
        expect(clientIpHeader(' CF-Connecting-IP ')).toBe('cf-connecting-ip');
        expect(clientIpHeader('  ')).toBeUndefined();
        expect(clientIpHeader(undefined)).toBeUndefined();
    });
});

describe('the share-image limiter', () => {
    it('allows the limit per window for each key, then starts over', () => {
        const limiter = fixedWindowLimiter({ limit: 2, windowMs: 1000 });
        expect([limiter.take('a', 0), limiter.take('a', 1), limiter.take('a', 2), limiter.take('b', 3)]).toEqual([true, true, false, true]);
        expect(limiter.take('a', 1000)).toBe(true);
    });

    it('holds at most maxKeys keys apart; newcomers past that share one count', () => {
        const limiter = fixedWindowLimiter({ limit: 1, windowMs: 1000, maxKeys: 1, overflowKeys: 1 });
        expect(limiter.take('a', 0)).toBe(true);
        expect(limiter.take('b', 0)).toBe(true);
        expect(limiter.take('c', 0)).toBe(false);
    });

    it("gives the newcomers past maxKeys many keys' worth between them, so that a full map does not shut new visitors out", () => {
        const limiter = fixedWindowLimiter({ limit: 1, windowMs: 1000, maxKeys: 1, overflowKeys: 3 });
        expect(limiter.take('a', 0)).toBe(true);
        expect([limiter.take('b', 0), limiter.take('c', 0), limiter.take('d', 0), limiter.take('e', 0)]).toEqual([true, true, true, false]);
        // A key it knows keeps its own count.
        expect(limiter.take('a', 0)).toBe(false);
    });
});

describe('the answers kept for a while', () => {
    it('shares one making with everyone who asks meanwhile, keeps it until it expires, and forgets a failure', async () => {
        const cache = ttlCache<number>({ ttlMs: 1000, max: 2 });
        let made = 0;
        const make = () => Promise.resolve(++made);
        const [first, second] = await Promise.all([cache.get('a', make, 0), cache.get('a', make, 1)]);
        expect([first, second, made]).toEqual([1, 1, 1]);
        expect(await cache.get('a', make, 999)).toBe(1);
        expect(await cache.get('a', make, 1000)).toBe(2);
        const failing = cache.get('b', () => Promise.reject(new Error('down')), 0);
        await expect(failing).rejects.toThrow('down');
        await Promise.resolve();
        expect(await cache.get('b', make, 1)).toBe(3);
    });

    it('drops the oldest past its size', async () => {
        const cache = ttlCache<string>({ ttlMs: 1000, max: 1 });
        await cache.get('a', () => Promise.resolve('a'), 0);
        await cache.get('b', () => Promise.resolve('b'), 0);
        expect(await cache.get('a', () => Promise.resolve('again'), 1)).toBe('again');
    });
});

describe('asking the API from the server', () => {
    it('says whom the render is for, with the token, and nothing without the token', () => {
        expect(internalApiHeaders()).toEqual({});
        vi.stubEnv('INTERNAL_API_TOKEN', 'x'.repeat(32));
        expect(internalApiHeaders()).toEqual({ 'x-internal-token': 'x'.repeat(32) });
        (globalThis as Record<symbol, unknown>)[VISITOR_STORE_KEY] = { getStore: () => ({ ip: '203.0.113.7' }) };
        expect(internalApiHeaders()).toEqual({ 'x-internal-token': 'x'.repeat(32), 'x-visitor-ip': '203.0.113.7' });
    });

    it('uses the internal address when there is one, without a trailing slash', () => {
        expect(apiBaseUrl()).toBe(API_URL);
        vi.stubEnv('API_INTERNAL_URL', 'http://backend:4100/');
        expect(apiBaseUrl()).toBe('http://backend:4100');
        vi.stubEnv('API_INTERNAL_URL', '  ');
        expect(apiBaseUrl()).toBe(API_URL);
    });
});
