/**
 * Egress monitor.
 *
 * The deployed page is served with `Content-Security-Policy: connect-src 'none'`,
 * so the browser itself refuses to open any data connection — this is enforced
 * by Chrome, not promised by us. This monitor exists so the *user* can see that
 * guarantee holding in real time, and so the same guarantee is visible during
 * local development, where the dev server needs a websocket for HMR and the CSP
 * is therefore relaxed.
 *
 * It counts every attempt to move bytes off the machine and never blocks them —
 * blocking is the CSP's job. If this counter ever moves during analysis, the
 * product's core promise is broken and the UI says so loudly.
 */
export interface EgressStats {
  armed: boolean;
  attempts: number;
  baseline: number;
  bytesOut: number;
  lastTarget: string | null;
}

const stats: EgressStats = {
  armed: false,
  attempts: 0,
  baseline: 0,
  bytesOut: 0,
  lastTarget: null,
};
const listeners = new Set<(s: EgressStats) => void>();

function record(target: string, bytes: number): void {
  if (!stats.armed) {
    stats.baseline++;
    return;
  }
  stats.attempts++;
  stats.bytesOut += bytes;
  stats.lastTarget = target;
  for (const fn of listeners) {
    fn(stats);
  }
}

function sizeOf(body: unknown): number {
  if (!body) {
    return 0;
  }
  if (typeof body === "string") {
    return body.length;
  }
  if (body instanceof Blob) {
    return body.size;
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }
  return 0;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

export function installEgressMonitor(): void {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ) {
    const url = requestUrl(input);
    record(url, sizeOf(init?.body));
    return nativeFetch.call(this, input, init);
  };

  const openNative = XMLHttpRequest.prototype.open as (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) => void;
  const sendNative = XMLHttpRequest.prototype.send;
  type TaggedXHR = XMLHttpRequest & { __url?: string };
  // Bound to a const first: assigning the literal straight onto the prototype
  // would contextually type the parameters from the overloaded native
  // signature, which widens `isAsync` to `unknown`.
  const patchedOpen = function (
    this: TaggedXHR,
    method: string,
    url: string | URL,
    isAsync = true,
    username?: string | null,
    password?: string | null
  ) {
    this.__url = String(url);
    openNative.call(this, method, url, isAsync, username, password);
  };
  XMLHttpRequest.prototype.open = patchedOpen;
  XMLHttpRequest.prototype.send = function (
    this: TaggedXHR,
    body?: Document | XMLHttpRequestBodyInit | null
  ) {
    record(this.__url ?? "xhr", sizeOf(body));
    sendNative.call(this, body as XMLHttpRequestBodyInit | null);
  };

  const NativeWS = globalThis.WebSocket;
  globalThis.WebSocket = class extends NativeWS {
    constructor(url: string | URL, protocols?: string | string[]) {
      record(String(url), 0);
      super(url, protocols);
    }
  } as unknown as typeof WebSocket;

  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      record(String(url), sizeOf(data));
      return beacon(url, data);
    };
  }

  const NativeES = globalThis.EventSource;
  if (NativeES) {
    globalThis.EventSource = class extends NativeES {
      constructor(url: string | URL, init?: EventSourceInit) {
        record(String(url), 0);
        super(url, init);
      }
    } as unknown as typeof EventSource;
  }
}

export function armEgressMonitor(): void {
  stats.armed = true;
  for (const fn of listeners) {
    fn(stats);
  }
}

export function onEgress(fn: (s: EgressStats) => void): () => void {
  listeners.add(fn);
  fn(stats);
  return () => listeners.delete(fn);
}

export function egressStats(): EgressStats {
  return stats;
}
