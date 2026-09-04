# Egress verification

Evidence for LocusLocal's core claim: **the page cannot transmit your genome,
because the browser refuses to let it.**

Run against the production build served by `src/worker.ts`, in Chrome
152.0.7977.65, on 2026-09-02. Reproduce with `pnpm build && pnpm exec wrangler dev`.

## Response headers

```
Content-Security-Policy: default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';
  worker-src 'self' blob:; connect-src 'none'; form-action 'none';
  frame-ancestors 'none'; base-uri 'none'; object-src 'none'
Origin-Agent-Cluster: ?1
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: geolocation=(), microphone=(), camera=(), usb=(), payment=(), interest-cohort=()
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

## Exfiltration attempts

Every outbound channel was given a genotype payload and a remote endpoint, with
a `securitypolicyviolation` listener attached. **All six were blocked.**

| Channel | Result | Blocked by |
|---|---|---|
| `fetch()` POST | blocked | `connect-src` |
| `XMLHttpRequest` POST | blocked | `connect-src` |
| `WebSocket` | blocked | `connect-src` |
| `navigator.sendBeacon` | blocked | `connect-src` |
| `EventSource` | blocked | `connect-src` |
| `new Image().src` with data in the query string | blocked | `img-src` |

Two things are worth being precise about, because they are easy to get wrong:

1. **`sendBeacon` returns `true` even when the request is blocked.** Per spec the
   return value means "queued for delivery", not "delivered"; the CSP still stops
   it, and the violation event fires. A return value of `true` is therefore not
   evidence that anything left the machine — the violation event is.
2. **Synchronous exceptions are not a reliable test.** Only `fetch()` rejects.
   XHR, WebSocket and EventSource fail asynchronously, so a naive try/catch
   around them reports "not blocked" when they are in fact blocked. The
   `securitypolicyviolation` event is the authoritative signal.

## The app still works under that policy

Same build, same headers:

| Check | Result |
|---|---|
| `document.modelContext` available | yes |
| `window.originAgentCluster` | `true` |
| Demo genome loaded (250,000 markers) | 1.13 s |
| Tools registered after load | 15 |
| `explain_findings` (minStars 2) | 7 findings — SLC2A1, ABCB11, BCHE, MYO7A, MYO18B … |
| Self-hosted fonts rendered | yes (`font-src 'self'`) |
| Egress counter (`egressStats()`) | `0 B`, no alarm banner raised |

The ClinVar subset and demo genome load as lazily `import()`ed script chunks, so
they arrive under `script-src` without the page ever being *able* to open a data
connection. `crossOriginIsolated` is `false` throughout — WebMCP needs only
`Origin-Agent-Cluster`, not COOP/COEP.
