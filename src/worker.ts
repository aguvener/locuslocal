/**
 * Cloudflare Worker serving the static build.
 *
 * Its whole job is the response headers. LocusLocal's core promise is that your
 * genome cannot leave the tab, and these headers are what make that a property
 * the browser enforces rather than a claim we ask you to believe:
 *
 *   connect-src 'none'  — fetch, XHR, WebSocket, EventSource and sendBeacon are
 *                         all unavailable. There is no code path, in our code or
 *                         in anything we ship, that can open a data connection.
 *   form-action 'none'  — no form can POST anywhere, including the export form.
 *   Origin-Agent-Cluster — required for document.modelContext to exist at all.
 *
 * Data the app needs (the ClinVar subset, the demo genome) is therefore shipped
 * as lazily imported script chunks, which are governed by script-src, not
 * connect-src. See docs/webmcp-probe-findings.md and the README trust boundary.
 */
/**
 * Minimal local declaration of the one Workers binding this file uses.
 * Pulling in @cloudflare/workers-types globally would replace the DOM's
 * `Response`/`Body` types across the whole client codebase, so the Worker
 * declares only what it needs.
 */
interface AssetFetcher {
  fetch: (request: Request) => Promise<Response>;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  // The two that matter: nothing may be transmitted anywhere, by anyone.
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  // WebMCP requires an origin-isolated document.
  "Origin-Agent-Cluster": "?1",
  // No reason for this page to ever touch a device sensor or the network stack.
  "Permissions-Policy":
    "geolocation=(), microphone=(), camera=(), usb=(), payment=(), interest-cohort=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export default {
  async fetch(
    request: Request,
    env: { ASSETS: AssetFetcher }
  ): Promise<Response> {
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      headers.set(k, v);
    }
    // The generated data chunks are content-hashed and immutable.
    if (new URL(request.url).pathname.startsWith("/assets/")) {
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
    }
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  },
};
