import { log } from "../log.ts";
import { sleep } from "./pool.ts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
    readonly method = "GET",
  ) {
    super(`HTTP ${status} ${method} ${url}\n${body.slice(0, 1200)}`);
    this.name = "HttpError";
  }

  /** Extract a readable message out of a Jira / ADO error payload. */
  get detail(): string {
    try {
      const j = JSON.parse(this.body) as Record<string, unknown>;
      const parts: string[] = [];
      if (Array.isArray(j.errorMessages)) parts.push(...(j.errorMessages as string[]));
      if (j.errors && typeof j.errors === "object") {
        for (const [k, v] of Object.entries(j.errors as Record<string, string>)) parts.push(`${k}: ${v}`);
      }
      if (typeof j.message === "string") parts.push(j.message);
      if (parts.length) return parts.join(" | ");
    } catch { /* body is not JSON */ }
    return this.body.slice(0, 300);
  }
}

export interface RequestOptions extends RequestInit {
  /** How many times to retry on 429/5xx/network errors. */
  retries?: number;
  /** Label shown in debug logs. */
  label?: string;
  /** Treat these statuses as valid and return the response instead of throwing. */
  tolerate?: number[];
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/**
 * fetch with retry, exponential backoff + jitter, honouring the `Retry-After` header.
 * Throws HttpError for any status >= 400 not listed in `tolerate`.
 */
export async function request(url: string, opts: RequestOptions = {}): Promise<Response> {
  const { retries = 5, label, tolerate = [], ...init } = opts;
  const method = (init.method ?? "GET").toUpperCase();

  for (let attempt = 0;; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // Deno reports every transport failure as a bare "fetch failed"; the real
      // reason (DNS, TLS, refused connection) only lives on `cause`.
      const reason = networkReason(err);
      const permanent = PERMANENT_NETWORK.test(reason);
      if (permanent || attempt >= retries) {
        throw new NetworkError(
          `Cannot reach ${new URL(url).origin} — ${reason}` + networkHint(reason, url),
          err,
        );
      }
      const wait = backoff(attempt);
      log.warn(`Network error ${label ?? url} -> retrying in ${Math.round(wait)}ms (${reason})`);
      await sleep(wait);
      continue;
    }

    if (res.ok || tolerate.includes(res.status)) return res;

    if (RETRYABLE.has(res.status) && attempt < retries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
      await res.body?.cancel();
      log.warn(`HTTP ${res.status} ${label ?? url} -> retrying in ${Math.round(wait)}ms`);
      await sleep(wait);
      continue;
    }

    throw new HttpError(res.status, url, await res.text().catch(() => ""), method);
  }
}

export async function requestJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(url, opts);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    const gateway = describeGateway(url, res, text);
    if (gateway) throw new GatewayError(gateway);
    throw new HttpError(res.status, url, `Response is not JSON: ${text.slice(0, 500)}`);
  }
}

/**
 * An API endpoint answering with HTML means something intercepted the request —
 * almost always a corporate SSO / VPN gateway (F5 BIG-IP APM, Azure App Proxy,
 * Okta, …) rather than a Jira or ADO fault. Say that plainly, because the raw
 * symptom ("response is not JSON") sends people hunting for the wrong bug.
 */
function describeGateway(url: string, res: Response, body: string): string | null {
  const looksHtml = /^\s*<(?:!doctype|html)\b/i.test(body) ||
    (res.headers.get("content-type") ?? "").includes("text/html");
  if (!looksHtml) return null;

  const requested = new URL(url);
  const landed = res.url ? new URL(res.url) : requested;
  const redirected = landed.pathname !== requested.pathname;

  const product = /BIG-?IP/i.test(body)
    ? "F5 BIG-IP Access Policy Manager"
    : /okta/i.test(body)
    ? "Okta"
    : /(saml|single sign-?on|login\.microsoftonline)/i.test(body)
    ? "an SSO portal"
    : "a proxy or login portal";

  return `${requested.origin} returned an HTML login page instead of JSON — ${product} ` +
    `intercepted the API call` +
    (redirected ? `, redirecting ${requested.pathname} to ${landed.pathname}` : "") +
    `.\n  The credentials were never seen by the server behind it. This host is only ` +
    `reachable from inside the corporate network, so connect to the VPN (or run the ` +
    `migration from a machine on that network) and try again.`;
}

/** A request that never reached the target server because a gateway answered first. */
export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayError";
  }
}

/** A transport-level failure: the request never produced an HTTP response. */
export class NetworkError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message);
    this.name = "NetworkError";
  }
}

/** Failures that will not fix themselves, so retrying only wastes time. */
const PERMANENT_NETWORK =
  /certificate|cert\b|self.signed|unknown issuer|dns error|failed to lookup|name not resolved|unknown host/i;

/** Unwrap Deno's "fetch failed" down to the cause that actually explains it. */
function networkReason(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    if (message && !parts.includes(message)) parts.push(message);
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  // "fetch failed" on its own says nothing; keep it only when it is all we have.
  const meaningful = parts.filter((p) => p !== "fetch failed");
  return (meaningful.length ? meaningful : parts).join(": ") || "unknown transport error";
}

/**
 * Turn the common transport failures into the action that fixes them. Deno
 * ships its own root store and ignores the OS one, which is the usual reason a
 * corporate host with an internal CA fails here but works in a browser.
 */
function networkHint(reason: string, url: string): string {
  if (/certificate|cert\b|self.signed|unknown issuer/i.test(reason)) {
    return `\n  Deno uses its own CA store and ignores the OS one, so an internal corporate CA ` +
      `is not trusted by default. Either export the CA and set DENO_CERT=/path/ca.pem, ` +
      `or set DENO_TLS_CA_STORE=system to use the operating system store.`;
  }
  if (/dns error|failed to lookup|name not resolved|unknown host/i.test(reason)) {
    return `\n  The hostname does not resolve. Check the spelling of ${new URL(url).hostname}, ` +
      `and whether it is an internal name that only resolves on the company VPN.`;
  }
  if (/refused|timed out|timeout|unreachable|reset/i.test(reason)) {
    return `\n  The host is not accepting connections from here. Connect to the company VPN, ` +
      `or check whether a firewall or proxy is in the way.`;
  }
  return "";
}

function backoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
}

export const basicAuth = (user: string, pass: string) =>
  "Basic " + btoa(unescape(encodeURIComponent(`${user}:${pass}`)));
