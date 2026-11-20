import { analysisFacts, formatSizeText, type AnalysisResponse } from '@weighme/core';
import { canonicalUrl } from '@config/site';

/** A badge as drawn, and how long it may be kept. */
export type Badge = { svg: string; cache: string };

const LABEL = 'gzip size';
const LABEL_COLOR = '#4b5563';
/** Both carry white text at more than 4.5:1. */
const MEASURED_COLOR = '#1257c2';
const NO_SIZE_COLOR = '#6b7280';
/** Close enough to Verdana at 11 px: `textLength` makes the text fit the box exactly, whatever font is there. */
const CHARACTER_WIDTH = 6.6;
const PADDING = 12;

const widthOf = (text: string): number => Math.round(text.length * CHARACTER_WIDTH) + PADDING;

const textAt = (text: string, x: number, width: number): string => `<text x="${x}" y="14" text-anchor="middle" textLength="${width - PADDING}" lengthAdjust="spacingAndGlyphs">${text}</text>`;

/** The SVG. Its two texts are this file's own and formatted numbers, never anything a package wrote, and it has no script or link of its own. */
const draw = (value: string, color: string): string => {
    const labelWidth = widthOf(LABEL);
    const valueWidth = widthOf(value);
    const width = labelWidth + valueWidth;
    const name = `${LABEL}: ${value}`;
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${name}">`,
        `<title>${name}</title>`,
        `<rect width="${labelWidth}" height="20" fill="${LABEL_COLOR}"/>`,
        `<rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>`,
        '<g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">',
        textAt(LABEL, labelWidth / 2, labelWidth),
        textAt(value, labelWidth + valueWidth / 2, valueWidth),
        '</g></svg>',
    ].join('');
};

/**
 * The badge of a package: its gzip size once measured, and otherwise what is known instead. What may change soon is kept
 * shorter: a badge is often the first thing that shows a package has not been measured, and a page opened later changes that.
 */
export const packageBadge = (analysis: AnalysisResponse | undefined, unavailable = false): Badge => {
    if (unavailable) return { svg: draw('unavailable', NO_SIZE_COLOR), cache: 'public, max-age=60' };
    const facts = analysis === undefined ? undefined : analysisFacts(analysis);
    if (facts?.state === 'failed') return { svg: draw('failed', NO_SIZE_COLOR), cache: 'public, max-age=300' };
    if (facts === undefined || facts.state === 'measuring') return { svg: draw('not measured', NO_SIZE_COLOR), cache: 'public, max-age=300' };
    return { svg: facts.state === 'measured' ? draw(formatSizeText(facts.sizes.gzip), MEASURED_COLOR) : draw('no bundle', NO_SIZE_COLOR), cache: 'public, max-age=3600, s-maxage=3600' };
};

/** What goes into a README: the badge, linking back to the package's page. Without a version, it follows the latest release. */
export const badgeMarkdown = (name: string): string => `[![gzip size of ${name}](${canonicalUrl(`/badge/${name}.svg`)})](${canonicalUrl(`/package/${name}`)})`;
