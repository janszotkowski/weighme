import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import handler from '@tanstack/react-start/server-entry';
import { API_URL } from '@config/api';
import { ALLOW_INDEXING, canonicalUrl } from '@config/site';
import { fetchKnownAnalysis, fetchMeasuredPackages } from '@lib/api';
import { clientIpHeader, requestIp } from '@lib/clientIp';
import { compressed } from '@lib/compression';
import { packagePathSpec, wantsMarkdown } from '@lib/documents/markdown';
import { createDocuments } from '@lib/documents/router';
import { renderDefaultOgImage, renderPackageOgImage } from '@lib/ogImage';
import { contentSecurityPolicy, documentPolicy, escapeScriptNuls, pageCacheControl, securityHeaders } from '@lib/securityHeaders';
import { VISITOR_STORE_KEY, visitorIp } from '@lib/visitor';

const SECURITY_HEADERS = securityHeaders();

/** The visitor each request renders for, read by the API client (`@config/api`) when it asks the API on their behalf. */
const visitors = new AsyncLocalStorage<{ ip: string | undefined }>();
(globalThis as Record<symbol, unknown>)[VISITOR_STORE_KEY] = visitors;
const CLIENT_IP_HEADER = clientIpHeader(process.env['CLIENT_IP_HEADER']);

/** Everything answered before the router; what it keeps between requests lives in it. */
const documentResponse = createDocuments({
    knownAnalysis: fetchKnownAnalysis,
    measuredPackages: fetchMeasuredPackages,
    drawDefaultImage: renderDefaultOgImage,
    drawPackageImage: renderPackageOgImage,
    visitor: visitorIp,
});

/**
 * The router answers 406 to an `Accept` without HTML (an agent asking for JSON or Markdown), so a page is always
 * rendered as HTML: agents get Markdown above where there is one, and an address with no page its 404 page.
 */
const asHtmlRequest = (request: Request): Request => {
    const accept = request.headers.get('accept');
    if (accept === null || (!wantsMarkdown(accept) && /text\/html|text\/\*|\*\/\*/i.test(accept))) return request;
    const headers = new Headers(request.headers);
    headers.set('accept', 'text/html');
    // Built from the URL, not wrapped: the server's own request object is not one `new Request` can copy. Reads only, so no body.
    return new Request(request.url, { method: request.method, headers });
};

const respond = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    let document: Response | undefined;
    if (isRead) {
        try {
            document = await documentResponse(request, pathname);
        } catch (error) {
            console.error('document failed', error);
            document = new Response('The service is busy; try again in a moment.', {
                status: 503,
                headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '30' },
            });
        }
    }
    // Marks the router's own inline scripts for this response only: the policy allows the scripts that carry it (and
    // no others), so a script that got into the page any other way is blocked. Never sent in a header.
    const nonce = randomBytes(18).toString('base64');
    const response = document ?? (await handler.fetch(isRead ? asHtmlRequest(request) : request, { context: { nonce } }));
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    // Nothing on a non-production environment belongs in a search index, and neither does an error page.
    if (!ALLOW_INDEXING) headers.set('X-Robots-Tag', 'noindex, nofollow');
    else if (response.status >= 400) headers.set('X-Robots-Tag', 'noindex');
    const acceptEncoding = request.headers.get('accept-encoding');
    if (response.headers.get('content-type')?.startsWith('text/html') !== true) {
        // Not a page, so no inline script to allow: the policy without hashes, which still says where anything may load from.
        if (import.meta.env.PROD) headers.set('Content-Security-Policy', contentSecurityPolicy(API_URL));
        return compressed(new Response(response.body, { status: response.status, statusText: response.statusText, headers }), acceptEncoding);
    }
    // Hashed and sent as one text: the same bytes reach every browser and the policy.
    const html = escapeScriptNuls(await response.text());
    const policy = documentPolicy(API_URL, html, import.meta.env.PROD, nonce);
    if (policy !== undefined) headers.set('Content-Security-Policy', policy);
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', pageCacheControl(response.status));
    // The same address answers Markdown to agents (package pages), so a shared cache must keep the two apart.
    headers.append('Vary', 'Accept');
    headers.append('Link', `<${canonicalUrl('/llms.txt')}>; rel="describedby"; type="text/plain"`);
    headers.append('Link', `<${canonicalUrl('/.well-known/api-catalog')}>; rel="api-catalog"`);
    const pkg = packagePathSpec(pathname);
    if (pkg !== undefined && !pkg.twin) headers.append('Link', `<${canonicalUrl(`/package/${pkg.spec}.md`)}>; rel="alternate"; type="text/markdown"`);
    // Rendered here, past Nitro's compression of static files.
    return compressed(new Response(html, { status: response.status, statusText: response.statusText, headers }), acceptEncoding);
};

/**
 * The server entry: documents and share images first, then pages. Every response goes out with the security headers
 * and, in production, a Content-Security-Policy; an HTML page's names the hashes of its inline scripts (so the whole
 * body is read) and comes with a cache policy a CDN can use, `Vary: Accept` and a `Link` to `llms.txt` for agents.
 * Pages and Markdown are compressed here, past Nitro's compression of static files. Each runs knowing whom it is for,
 * so that what it asks the API counts against that visitor.
 */
export default {
    fetch: (request: Request) => visitors.run({ ip: requestIp(request, CLIENT_IP_HEADER) }, () => respond(request)),
};
