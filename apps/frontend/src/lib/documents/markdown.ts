import { analysisFacts, parseSpec, type AnalysisResponse } from '@weighme/core';
import { canonicalUrl, siteConfig } from '@config/site';
import { formatDownloadTimes, formatSizeText } from '@lib/format';

const acceptQualities = (accept: string): Map<string, number> => {
    const qualities = new Map<string, number>();
    for (const part of accept.split(',')) {
        const [type = '', ...parameters] = part.trim().toLowerCase().split(';');
        const quality = parameters.map((parameter) => /^\s*q=([\d.]+)\s*$/.exec(parameter)?.[1]).find((value) => value !== undefined);
        qualities.set(type.trim(), quality === undefined ? 1 : Number(quality));
    }
    return qualities;
};

/** An agent asking for Markdown at least as much as for HTML. A browser never does, and neither does a bare `*\/*`. */
export const wantsMarkdown = (accept: string | null | undefined): boolean => {
    if (!accept) return false;
    const qualities = acceptQualities(accept);
    const markdown = qualities.get('text/markdown') ?? 0;
    const html = qualities.get('text/html') ?? qualities.get('text/*') ?? qualities.get('*/*') ?? 0;
    return markdown > 0 && markdown >= html;
};

/** A rough size for agents budgeting their context. */
export const markdownTokens = (markdown: string): number => Math.ceil(markdown.length / 4);

/**
 * The package of `/package/react.md` or `/package/react`, or undefined: for any other address, and for one that names no
 * package anyone could ask for (an encoding that does not decode, a name the registry would refuse). Only a spec that
 * passes here goes on to the API or into a response header.
 */
export const packagePathSpec = (pathname: string): { spec: string; twin: boolean } | undefined => {
    const match = /^\/package\/(.+?)(\.md)?$/.exec(pathname);
    if (match?.[1] === undefined) return undefined;
    let spec: string;
    try {
        spec = decodeURIComponent(match[1]);
    } catch {
        return undefined;
    }
    return parseSpec(spec) === undefined ? undefined : { spec, twin: match[2] !== undefined };
};

/** The author's text on one line of Markdown, taken literally: its own Markdown or HTML must not become ours. */
const mdText = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ').replace(/[\\`*_[\]<>|~&]/g, (char) => `\\${char}`);

const line = (label: string, value: string): string => `- **${label}:** ${value}`;

/** A measured package as Markdown: the same facts as its page, for agents. */
export const packageMarkdown = (analysis: AnalysisResponse): string => {
    const { name, version } = analysis.package;
    const url = canonicalUrl(`/package/${name}`);
    const facts = analysisFacts(analysis);
    if (facts.state === 'failed') return `# ${name}@${version}\n\nThis package could not be measured: ${mdText(facts.failure.message)}\n\n[Its page](${url})\n`;
    if (facts.state === 'measuring') return `# ${name}@${version}\n\nThis package is being measured. Ask again in a moment.\n\n[Its page](${url})\n`;
    const { result, exports } = facts;
    const sections = [`# ${name}@${version}\n`];
    if (result.description !== null) sections.push(`${mdText(result.description)}\n`);
    const lines: string[] = [];
    if (facts.state === 'nothing-to-import') {
        lines.push(`This package has nothing to import, so it adds nothing to a bundle.${result.commands.length > 0 ? ` It installs the commands: ${result.commands.map(mdText).join(', ')}.` : ''}`);
    } else {
        lines.push(line('Minified and gzipped', formatSizeText(facts.sizes.gzip)), line('Minified', formatSizeText(facts.sizes.minified)), line('Brotli', formatSizeText(facts.sizes.brotli)));
        if (!facts.madeForNode) lines.push(line('Download time', formatDownloadTimes(facts.sizes.gzip)));
    }
    lines.push(line('Install size', formatSizeText(result.install.bytes)), line('Packages installed', String(result.install.packages)));
    if (result.peerDependencies.length > 0) lines.push(line('Peer dependencies, not counted', result.peerDependencies.map(mdText).join(', ')));
    if (facts.madeForNode) lines.push('- It is made for Node.js, so the size is not what it costs in a web page.');
    lines.push(line('Measured with', `${result.bundler.name} ${result.bundler.version}`));
    if (result.repositoryUrl !== null) lines.push(line('Source', `<${result.repositoryUrl}>`));
    sections.push(`${lines.join('\n')}\n`);
    if (facts.state === 'measured' && result.composition.total > 1) {
        const parts = result.composition.packages.map((part) => `- ${mdText(part.name)}: ${Math.round(part.share * 100)}%`);
        sections.push(`## What the bundle is made of\n\n${parts.join('\n')}\n`);
    }
    if (exports.status === 'done' && exports.details.named.length > 0) {
        const named = exports.details.named.slice(0, 50).map((part) => `- \`${part.name}\`: ${formatSizeText(part.gzip)} gzip`);
        sections.push(`## Named exports, largest first\n\n${named.join('\n')}\n`);
    }
    sections.push(`[${name} on ${siteConfig.title}](${url})\n`);
    return sections.join('\n');
};

/** The package has not been measured: an agent is told so, and nothing is downloaded for it. */
export const notMeasuredMarkdown = (spec: string): string => `# Not measured\n\n${mdText(spec)} has not been measured yet, or is not on npm. Open ${canonicalUrl(`/package/${spec}`)} to measure it.\n`;
