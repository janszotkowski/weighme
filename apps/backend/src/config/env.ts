import { z } from 'zod';

const flag = (fallback: 'true' | 'false') =>
    z
        .enum(['true', 'false'])
        .default(fallback)
        .transform((value) => value === 'true');

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** The values in `.env.example`. They are public, so they are fine on a laptop and refused in production. */
const EXAMPLE_WORKER_TOKEN = 'local-development-only-not-a-secret';
const EXAMPLE_INTERNAL_TOKEN = 'local-development-only-render-token-not-a-secret';

/** Headers proxies append to: their first entry is whatever the caller sent, so they never name the caller. */
const CHAIN_HEADERS = new Set(['x-forwarded-for', 'forwarded']);

/** An optional text setting: unset and blank are the same, and blanks around the value are not part of it. */
const optionalText = z
    .string()
    .optional()
    .transform((value) => {
        const text = value?.trim();
        return text === undefined || text === '' ? undefined : text;
    });

/**
 * Every setting the backend reads from the environment, validated once at start-up. Nothing else reads `process.env`:
 * a missing or malformed value stops the process with a readable message instead of failing later.
 */
const envSchema = z
    .object({
        NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
        HOST: z.string().min(1).default('127.0.0.1'),
        PORT: z.coerce.number().int().min(1).max(65535).default(4100),
        LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
        APP_VERSION: z.string().min(1).default('dev'),
        /** Comma-separated origins allowed to call the API from a browser. When unset, any local port, except in production, which must name them. */
        CORS_ORIGINS: z
            .string()
            .optional()
            .transform((value) =>
                (value ?? '')
                    .split(',')
                    .map((origin) => origin.trim())
                    .filter((origin) => origin !== ''),
            ),
        /** The SQLite file. Its folder is created when missing; `:memory:` keeps it in memory (tests). */
        DATABASE_PATH: z.string().min(1).default('./data/weighme.db'),
        /** What the worker sends to take jobs and hand in results. */
        WORKER_TOKEN: z.string().min(32),
        /** Optional: GitHub allows 60 questions an hour without a token, for the stars in the trends table. It needs no permissions. */
        GITHUB_TOKEN: z.string().min(1).optional(),
        /** Packages waiting at most, and versions queued for later at most, separately; beyond it the API answers 503 instead of piling up work. */
        QUEUE_MAX_WAITING: z.coerce.number().int().min(1).max(100_000).default(200),
        /** A job whose worker said nothing for this long is taken away from it. Must outlast the worker's own job timeout. */
        JOB_LEASE_SECONDS: z.coerce.number().int().min(10).max(3600).default(180),
        /** How many times a package is tried when its worker disappears. A failure the worker reports is not retried at once. */
        JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(2),
        /** A failed package is measured again after this long: the failure may have been a registry hiccup. */
        JOB_FAILED_RETRY_MINUTES: z.coerce.number().int().min(1).max(100_000).default(60),
        /** Requests one caller may make per minute to `/v1/*` (health excepted); one more is answered 429 with `Retry-After`. A page asks every second while its package is measured. */
        RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(300),
        /** Offer the MCP server at `/v1/mcp`. Off answers 404 there, and the rest of the API is untouched. */
        MCP_ENABLED: flag('true'),
        /** Requests to `/v1/mcp` one caller may make per minute, on top of the general limit. */
        RATE_LIMIT_MCP_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(60),
        /** Requests to `/v1/mcp` all callers together may make per minute: its most, however many addresses a flood comes from. */
        RATE_LIMIT_MCP_TOTAL_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(1200),
        /** Requests the frontend's rendering may make per minute for one visitor: a page asks for several things at once. */
        RATE_LIMIT_RENDER_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(600),
        /**
         * Packages one caller may add to the queue per minute by asking what they cost, and times it may queue a package's
         * versions (`POST /v1/history`): each has the worker download them. Asking for what is known costs none of it.
         */
        RATE_LIMIT_QUEUE_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(10),
        /**
         * The header the proxy in front of the API writes the caller's address into (`cf-connecting-ip` behind Cloudflare,
         * `x-real-ip` behind nginx or Caddy). Unset, the address of the connection is used. Set it only behind a proxy that
         * overwrites the header: otherwise a caller can choose its own address and escape the limit. A header a proxy appends
         * to (`x-forwarded-for`, `forwarded`) is refused: its first entry is the caller's word. A request carrying this header
         * came through the proxy, so `/internal/*`, which only the worker inside the machine calls, answers it 404.
         */
        CLIENT_IP_HEADER: optionalText
            .transform((value) => value?.toLowerCase())
            .refine((value) => value === undefined || !CHAIN_HEADERS.has(value), {
                message: 'a header proxies append to starts with whatever the caller sent: name one the proxy overwrites with a single address (cf-connecting-ip, x-real-ip)',
            }),
        /**
         * A shared secret the frontend's server sends as `x-internal-token` (at least 32 characters). Its rendering speaks for
         * every visitor at once, so it is not limited as one caller: each visitor it names in `x-visitor-ip` is counted
         * against `RATE_LIMIT_RENDER_PER_MINUTE` instead, and the requests that name none (documents for crawlers) are counted
         * together against the same limit, so a rendering that lost sight of its visitors cannot ask without end.
         */
        INTERNAL_API_TOKEN: optionalText.refine((value) => value === undefined || value.length >= 32, { message: 'must be at least 32 characters' }),
    })
    .superRefine((env, context) => {
        if (env.NODE_ENV !== 'production') return;
        if (env.WORKER_TOKEN === EXAMPLE_WORKER_TOKEN) context.addIssue({ code: 'custom', path: ['WORKER_TOKEN'], message: 'is the public example value: set a random one' });
        if (env.INTERNAL_API_TOKEN === EXAMPLE_INTERNAL_TOKEN) context.addIssue({ code: 'custom', path: ['INTERNAL_API_TOKEN'], message: 'is the public example value: set a random one' });
        if (env.CORS_ORIGINS.length === 0) context.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'must name the allowed origins in production' });
    });

export type Config = z.infer<typeof envSchema>;

export type LoadedConfig = { ok: true; config: Config } | { ok: false; problems: string[] };

/** The settings, read once. An empty value is an unset one: Compose writes `KEY=` for `${KEY:-}`, and that must mean "use the default". */
export const loadConfig = (env: Record<string, string | undefined> = process.env): LoadedConfig => {
    const parsed = envSchema.safeParse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== '')));
    if (parsed.success) return { ok: true, config: parsed.data };
    return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
};
