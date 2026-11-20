import { describe, expect, it } from 'vitest';
import { createCallerShares, type Caller } from '@platform/http/caller-shares.ts';

const TOKEN = 'test-render-token-of-at-least-32-characters';

const ROUTES = {
    isFree: (path: string): boolean => path === '/v1/health',
    alwaysQueues: (method: string, path: string): boolean => method === 'POST' && path === '/v1/history',
    isForAgents: (path: string): boolean => path.startsWith('/v1/mcp'),
};

const LIMITS = {
    RATE_LIMIT_PER_MINUTE: 3,
    RATE_LIMIT_RENDER_PER_MINUTE: 5,
    RATE_LIMIT_QUEUE_PER_MINUTE: 1,
    RATE_LIMIT_MCP_PER_MINUTE: 2,
    RATE_LIMIT_MCP_TOTAL_PER_MINUTE: 3,
    INTERNAL_API_TOKEN: TOKEN,
};

const setup = (limits: Partial<typeof LIMITS> = {}) => {
    const sharesOf = createCallerShares({ ...LIMITS, ...limits }, ROUTES, () => 0);
    const ask = (caller: Partial<Caller> = {}) =>
        sharesOf({ method: 'GET', path: '/v1/analyses', internalToken: undefined, visitor: undefined, proxied: undefined, socketAddress: '203.0.113.1', ...caller });
    /** Whether each of this many requests in a row was allowed. */
    const allowed = (times: number, caller: Partial<Caller> = {}): boolean[] => Array.from({ length: times }, () => ask(caller)?.result.allowed ?? true);
    return { ask, allowed };
};

describe("a caller's shares", () => {
    it('counts nothing for a route that is free', () => {
        const { ask, allowed } = setup();
        expect(ask({ path: '/v1/health' })).toBeUndefined();
        expect(allowed(3)).toEqual([true, true, true]);
    });

    it('gives each address a share of its own, and reports what is left of it', () => {
        const { ask, allowed } = setup();
        expect(ask()?.result).toEqual({ allowed: true, limit: 3, remaining: 2, resetSeconds: 60 });
        expect(allowed(3)).toEqual([true, true, false]);
        expect(allowed(1, { socketAddress: '203.0.113.2' })).toEqual([true]);
    });

    it('takes the address the trusted proxy wrote over the connection, and an IPv6 caller by its /64', () => {
        const { allowed } = setup();
        expect(allowed(3, { proxied: '198.51.100.7' })).toEqual([true, true, true]);
        expect(allowed(3, { proxied: '198.51.100.8' })).toEqual([true, true, true]);
        expect(allowed(4, { proxied: '2001:db8::1' })).toEqual([true, true, true, false]);
        expect(allowed(1, { proxied: '2001:db8::2' })).toEqual([false]);
    });

    it.each([
        ['a visitor it names', { visitor: '198.51.100.7' }],
        ['no visitor', {}],
        ['a visitor that is no address', { visitor: 'not-an-address' }],
    ])('counts a rendering with %s against a render-sized share', (_name, caller) => {
        const { allowed } = setup();
        expect(allowed(6, { internalToken: TOKEN, ...caller })).toEqual([true, true, true, true, true, false]);
    });

    it('keeps the visitors a rendering names apart, and ignores the name without the token', () => {
        const { allowed } = setup();
        allowed(5, { internalToken: TOKEN, visitor: '198.51.100.7' });
        expect(allowed(1, { internalToken: TOKEN, visitor: '198.51.100.8' })).toEqual([true]);
        expect(allowed(4, { internalToken: 'x'.repeat(40), visitor: '198.51.100.9' })).toEqual([true, true, true, false]);
        expect(allowed(1, { visitor: '198.51.100.10' })).toEqual([false]);
    });

    it("counts a route that always queues against the share of queueing, and reports that share's numbers", () => {
        const { ask } = setup();
        const history = { method: 'POST', path: '/v1/history' };
        expect(ask(history)?.result).toMatchObject({ allowed: true, limit: 1, remaining: 0 });
        expect(ask(history)?.result).toMatchObject({ allowed: false, limit: 1 });
        // Reading the same path costs none of it.
        expect(ask({ path: '/v1/history' })?.result).toMatchObject({ allowed: true, limit: 3 });
    });

    it('lets a route count what it queues, and refuses past the share', () => {
        const { ask } = setup();
        const shares = ask();
        expect(() => shares?.queueShare()).not.toThrow();
        expect(() => shares?.queueShare()).toThrow('Too many packages asked to be measured');
        // The share is the caller's, not the request's.
        expect(() => ask()?.queueShare()).toThrow('Too many packages asked to be measured');
        expect(() => ask({ socketAddress: '203.0.113.2' })?.queueShare()).not.toThrow();
    });

    it('counts an agent against a share of its own, reported in the headers', () => {
        const { ask } = setup({ RATE_LIMIT_PER_MINUTE: 10 });
        const agent = { method: 'POST', path: '/v1/mcp' };
        expect(ask(agent)?.result).toMatchObject({ allowed: true, limit: 2, remaining: 1 });
        expect(ask(agent)?.result).toMatchObject({ allowed: true, limit: 2, remaining: 0 });
        expect(ask(agent)?.result).toMatchObject({ allowed: false, limit: 2 });
    });

    it('holds all agents together to a total, which speaks only when it says no', () => {
        const { ask } = setup({ RATE_LIMIT_PER_MINUTE: 10 });
        const agent = (socketAddress: string) => ask({ method: 'POST', path: '/v1/mcp', socketAddress })?.result;
        expect(agent('203.0.113.1')).toMatchObject({ allowed: true, limit: 2 });
        expect(agent('203.0.113.2')).toMatchObject({ allowed: true, limit: 2 });
        expect(agent('203.0.113.3')).toMatchObject({ allowed: true, limit: 2 });
        expect(agent('203.0.113.4')).toMatchObject({ allowed: false, limit: 3 });
    });
});
