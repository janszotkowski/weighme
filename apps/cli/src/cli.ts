import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ApiError, createApiClient, formatSizeText, isMadeForNode, parseSpec, type AnalysisResponse, type AnalysisResult } from '@weighme/core';

/** Where the API is until the site is deployed (docs/TODO.md): the one `pnpm dev` starts. */
export const DEFAULT_API_URL = 'http://127.0.0.1:4100';

/** How often to ask while a package is being measured, and for how long: the same pace as the package page. */
const POLL_MS = 1000;
const WAIT_MS = 120_000;

const USAGE = `Usage: weighme <package> [--json] [--api <url>]

What an npm package costs your bundle. A package not measured yet is measured on the server; its code is never run.

  <package>      A name, optionally with a version or tag: react, react@19.1.0, react@next
  --json         The API's whole answer as JSON
  --api <url>    The API to ask (or WEIGHME_API_URL); default ${DEFAULT_API_URL}
  --help         This text
`;

/** What the command touches of the outside world, so that tests stand in for all of it. */
export type CliIo = {
    fetch: typeof fetch;
    env: Readonly<Record<string, string | undefined>>;
    out: (text: string) => void;
    err: (text: string) => void;
    pollMs?: number;
    waitMs?: number;
};

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

type Options = { spec: string; json: boolean; api: string };

/** The command line as options, or undefined when it asks for something that cannot be done. */
const parseCommandLine = (argv: string[], env: CliIo['env']): Options | 'help' | undefined => {
    let parsed;
    try {
        parsed = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' }, api: { type: 'string' }, help: { type: 'boolean' } } });
    } catch {
        return undefined;
    }
    if (parsed.values.help === true) return 'help';
    const [spec, ...rest] = parsed.positionals;
    const api = parsed.values.api ?? env['WEIGHME_API_URL'] ?? DEFAULT_API_URL;
    if (spec === undefined || rest.length > 0 || parseSpec(spec) === undefined || !/^https?:\/\//.test(api) || !URL.canParse(api)) return undefined;
    return { spec, json: parsed.values.json === true, api: api.replace(/\/+$/, '') };
};

/** Asks until the package has been measured, or until it is not worth waiting. Once the first answer names the exact version, only that is asked for: a tag would cost a question to the registry every time. */
const measure = async (options: Options, io: CliIo): Promise<AnalysisResponse> => {
    const deadline = Date.now() + (io.waitMs ?? WAIT_MS);
    const client = createApiClient({ baseUrl: options.api, fetch: io.fetch });
    let spec = options.spec;
    for (;;) {
        const answer = await client.analysis(spec);
        if (answer.status === 'done' || answer.status === 'failed' || Date.now() >= deadline) return answer;
        spec = `${answer.package.name}@${answer.package.version}`;
        await sleep(io.pollMs ?? POLL_MS);
    }
};

const row = (label: string, value: string): string => `  ${label.padEnd(10)}${value}\n`;

/**
 * A finished result for reading in a terminal. It prints numbers and nothing a package's author wrote (its description,
 * its commands): text from a package could carry escape sequences, and `--json` has it all, safely escaped.
 */
const report = (result: AnalysisResult): string => {
    const sizes = result.sizes;
    const lines =
        sizes === null
            ? ['  Nothing to import, so there is no bundle size.\n']
            : [row('Minified', formatSizeText(sizes.minified)), row('Gzip', formatSizeText(sizes.gzip)), row('Brotli', formatSizeText(sizes.brotli))];
    const { packages } = result.install;
    lines.push(row('Install', `${formatSizeText(result.install.bytes)}, ${packages} ${packages === 1 ? 'package' : 'packages'}`));
    if (result.peerDependencies.length > 0) lines.push(`  ${result.peerDependencies.length} peer ${result.peerDependencies.length === 1 ? 'dependency is' : 'dependencies are'} not counted.\n`);
    if (isMadeForNode(result.environment)) lines.push('  Made for Node.js: this is not what it costs in a browser.\n');
    return lines.join('');
};

/** Runs the command and answers its exit code: 0 with a result, 1 without one, 2 for a command line that makes no sense. */
export const run = async (argv: string[], io: CliIo): Promise<number> => {
    const options = parseCommandLine(argv, io.env);
    if (options === 'help') {
        io.out(USAGE);
        return EXIT_OK;
    }
    if (options === undefined) {
        io.err(USAGE);
        return EXIT_USAGE;
    }
    let answer: AnalysisResponse;
    try {
        answer = await measure(options, io);
    } catch (error) {
        io.err(error instanceof ApiError ? `${error.message}\n` : `No usable answer from the API at ${options.api}.\n`);
        return EXIT_FAILED;
    }
    if (options.json) io.out(`${JSON.stringify(answer, null, 2)}\n`);
    const name = `${answer.package.name}@${answer.package.version}`;
    if (answer.status === 'done') {
        if (!options.json) io.out(`${name}\n${report(answer.result)}`);
        return EXIT_OK;
    }
    // In words only the code: the message of a failure carries what the install printed, which a package can influence.
    io.err(answer.status === 'failed' ? `${name} could not be measured (${answer.failure.code}).\n` : `${name} is still being measured. Run this again in a moment.\n`);
    return EXIT_FAILED;
};
