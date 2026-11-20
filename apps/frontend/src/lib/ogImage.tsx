import { renderAsync } from '@resvg/resvg-js';
import type { AnalysisResult, PackageRef } from '@weighme/core';
import type { ReactNode } from 'react';
import satori from 'satori';
import interRegular from '@fontsource/inter/files/inter-latin-400-normal.woff?inline';
import interSemibold from '@fontsource/inter/files/inter-latin-600-normal.woff?inline';
import interExtRegular from '@fontsource/inter/files/inter-latin-ext-400-normal.woff?inline';
import interExtSemibold from '@fontsource/inter/files/inter-latin-ext-600-normal.woff?inline';
import { siteConfig } from '@config/site';
import { formatSizeText } from '@lib/format';
import { OG_IMAGE_SIZE, clip } from '@lib/head';

/** The dark theme's tokens (`app.css`): the card looks like the site it links to. */
const COLOR = { background: '#000000', foreground: '#f5f5f7', muted: '#a6a6ae', border: '#26262c', accent: '#5aa2ff' };

// Vite inlines the font files as data URLs, so the server bundle needs no file next to it at run time. Satori reads
// WOFF, not WOFF2; latin-ext has a family name of its own because satori falls back only across names.
const fontData = (dataUrl: string): Buffer => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
const FONTS = [
    { name: 'Inter', data: fontData(interRegular), weight: 400 as const, style: 'normal' as const },
    { name: 'Inter', data: fontData(interSemibold), weight: 600 as const, style: 'normal' as const },
    { name: 'Inter Ext', data: fontData(interExtRegular), weight: 400 as const, style: 'normal' as const },
    { name: 'Inter Ext', data: fontData(interExtSemibold), weight: 600 as const, style: 'normal' as const },
];

type FrameProps = { children: ReactNode };

const Frame = (props: FrameProps) => (
    <div
        style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            width: '100%',
            height: '100%',
            padding: 72,
            background: COLOR.background,
            color: COLOR.foreground,
            fontFamily: 'Inter, Inter Ext',
        }}
    >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 30, fontWeight: 600 }}>
            <div style={{ display: 'flex', width: 18, height: 18, borderRadius: 9, background: COLOR.accent }} />
            {siteConfig.title}
        </div>
        {props.children}
    </div>
);

/**
 * Satori lays the card out as SVG (in this thread: it is JavaScript and WebAssembly), and resvg rasterizes it on
 * libuv's thread pool (`renderAsync`), so the costlier half never holds the event loop the pages are served from.
 */
const toPng = async (element: ReactNode): Promise<Buffer> => {
    const svg = await satori(element, { ...OG_IMAGE_SIZE, fonts: FONTS });
    return (await renderAsync(svg, { fitTo: { mode: 'width', value: OG_IMAGE_SIZE.width } })).asPng();
};

/** The site's card: what it is, for links to the home page and the other pages. */
export const renderDefaultOgImage = (): Promise<Buffer> =>
    toPng(
        <Frame>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div style={{ display: 'flex', fontSize: 76, fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1.05 }}>What does this package really cost?</div>
                <div style={{ display: 'flex', fontSize: 34, color: COLOR.muted }}>Minified, gzip and brotli sizes of any npm package. Free and open source.</div>
            </div>
        </Frame>,
    );

type FigureProps = { label: string; value: string };

const Figure = (props: FigureProps) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 26, color: COLOR.muted }}>{props.label}</span>
        <span style={{ fontSize: 44, fontWeight: 600 }}>{props.value}</span>
    </div>
);

/** A package's card: its name, what it costs and what it is. Only what its public page shows. */
export const renderPackageOgImage = (ref: PackageRef, result: AnalysisResult): Promise<Buffer> =>
    toPng(
        <Frame>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div style={{ display: 'flex', fontSize: 64, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.1 }}>{clip(ref.name, 40)}</div>
                {result.description !== null && <div style={{ display: 'flex', fontSize: 30, color: COLOR.muted, lineHeight: 1.3 }}>{clip(result.description, 110)}</div>}
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 72 }}>
                {result.sizes === null ? null : (
                    <Figure
                        label={'Minified + gzip'}
                        value={formatSizeText(result.sizes.gzip)}
                    />
                )}
                {result.sizes === null ? null : (
                    <Figure
                        label={'Minified'}
                        value={formatSizeText(result.sizes.minified)}
                    />
                )}
                <Figure
                    label={'Install size'}
                    value={formatSizeText(result.install.bytes)}
                />
                <div style={{ display: 'flex', fontSize: 28, color: COLOR.muted, marginLeft: 'auto' }}>v{clip(ref.version, 18)}</div>
            </div>
        </Frame>,
    );
