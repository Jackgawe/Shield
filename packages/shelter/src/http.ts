import { after, instead } from "spitroast";
import { DiscordHTTP, HTTPApi, HTTPRequest, HTTPResponse } from "./types";

const methods = ["get", "post", "put", "patch", "del"];

let resolve: () => void;
export let ready = new Promise<void>((res) => (resolve = res));
export let discordHttp: DiscordHTTP;

const api: HTTPApi = {
  intercept,
  ready,
  get _raw() {
    return discordHttp;
  },
};

for (const fun of methods) {
  api[fun] = (...args: any[]) => {
    if (discordHttp === undefined) throw new Error("HTTP method used before API was ready");
    return discordHttp[fun](...args);
  };
}

export default api;

const unpatch = after("bind", Function.prototype, function (args, res) {
  if (args.length !== 2 || args[0] !== null || args[1] !== "get") return;
  unpatch();
  return function (...args) {
    // I don't know why, but for the first call `this` is Window
    if (this && this !== window) {
      this.get = res;
      discordHttp = this;
      Object.assign(api, discordHttp);
      resolve();
    }
    return res(...args);
  };
});

export let unpatchHttpHandlers;
function patchHttpHandlers() {
  if (unpatchHttpHandlers) return;
  const patches = methods.map((fun) =>
    instead(fun, discordHttp, async (args, original) => {
      let req = args[0];
      if (typeof req === "string") {
        req = { url: req };
      }

      const iterator = intercepts[Symbol.iterator]();

      function send(req: HTTPRequest): Promise<HTTPResponse> {
        const { value, done } = iterator.next();
        if (!done) {
          const [method, filter, intercept] = value as Intercept;
          if (method.toLowerCase() !== fun || !filter(req.url)) return send(req);

          let called = false;
          function sendOnce(req: HTTPRequest): Promise<HTTPResponse> {
            if (called) throw new Error("You cannot call 'send' more than once.");
            called = true;
            return send(req);
          }

          return intercept(req, sendOnce);
        }
        return original(req, args[1]);
      }

      return send(req);
    }),
  );

  unpatchHttpHandlers = () => patches.forEach((p) => p());
}

type Method = "get" | "post" | "put" | "patch" | "del";
type FilterFn = (url: string) => boolean;
type InterceptFn = (
  req: HTTPRequest,
  send: (req: HTTPRequest | undefined) => Promise<HTTPResponse>,
) => Promise<HTTPResponse>;
type Intercept = [Method, FilterFn, InterceptFn];

const intercepts: Intercept[] = [];

export function intercept(method: Method, filter: string | RegExp | FilterFn, fun: InterceptFn) {
  ready.then(patchHttpHandlers);

  let filterFn: FilterFn;
  if (typeof filter === "string") {
    filterFn = (url) => url === filter;
  } else if (filter instanceof RegExp) {
    filterFn = (url) => url.search(filter) !== -1;
  } else {
    filterFn = filter;
  }

  const pair: Intercept = [method, filterFn, fun];
  intercepts.push(pair);
  return () => {
    const index = intercepts.indexOf(pair);
    if (index !== -1) intercepts.splice(index, 1);
  };
}

// Add request rate limiting
const rateLimits = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 100;

function checkRateLimit(url: string): boolean {
  const now = Date.now();
  const limit = rateLimits.get(url) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };

  if (now > limit.resetTime) {
    limit.count = 0;
    limit.resetTime = now + RATE_LIMIT_WINDOW;
  }

  if (limit.count >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }

  limit.count++;
  rateLimits.set(url, limit);
  return true;
}

// Add request caching
const cache = new Map<string, { data: any; expiry: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function getCachedResponse(url: string): Promise<any | null> {
  const cached = cache.get(url);
  if (cached && Date.now() < cached.expiry) {
    return cached.data;
  }
  return null;
}

function setCachedResponse(url: string, data: any): void {
  cache.set(url, {
    data,
    expiry: Date.now() + CACHE_DURATION,
  });
}

// Add request queue for better management
const requestQueue = new Map<string, Promise<any>>();

async function queueRequest<T>(url: string, requestFn: () => Promise<T>): Promise<T> {
  if (requestQueue.has(url)) {
    return requestQueue.get(url) as Promise<T>;
  }

  const request = requestFn().finally(() => {
    requestQueue.delete(url);
  });

  requestQueue.set(url, request);
  return request;
}

// Add security headers
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline';",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

// Add request validation
function validateRequest(url: string, options?: RequestInit): string[] {
  const errors: string[] = [];

  try {
    const parsedUrl = new URL(url);

    // Validate URL
    if (!parsedUrl.protocol.startsWith("http")) {
      errors.push("Only HTTP(S) URLs are allowed");
    }

    // Validate headers
    if (options?.headers) {
      const headers = new Headers(options.headers);
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
        if (headers.has(key) && headers.get(key) !== value) {
          errors.push(`Invalid ${key} header`);
        }
      }
    }

    // Validate method
    if (options?.method && !["GET", "POST", "PUT", "DELETE", "PATCH"].includes(options.method.toUpperCase())) {
      errors.push("Invalid HTTP method");
    }
  } catch (e) {
    errors.push("Invalid URL");
  }

  return errors;
}

// Enhance fetch function
export async function safeFetch<T>(url: string, options?: RequestInit): Promise<T> {
  // Validate request
  const errors = validateRequest(url, options);
  if (errors.length > 0) {
    throw new Error(`Request validation failed: ${errors.join(", ")}`);
  }

  // Check rate limit
  if (!checkRateLimit(url)) {
    throw new Error("Rate limit exceeded");
  }

  // Check cache for GET requests
  if (!options?.method || options.method.toUpperCase() === "GET") {
    const cached = await getCachedResponse(url);
    if (cached) return cached;
  }

  // Queue request
  return queueRequest(url, async () => {
    try {
      // Add security headers
      const headers = new Headers(options?.headers);
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
        headers.set(key, value);
      }

      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      // Cache successful GET responses
      if (!options?.method || options.method.toUpperCase() === "GET") {
        setCachedResponse(url, data);
      }

      return data;
    } catch (e) {
      console.error(`Request failed for ${url}:`, e);
      throw e;
    }
  });
}

// Add request interceptors
type Interceptor = (request: Request) => Request | Promise<Request>;
const interceptors: Interceptor[] = [];

export function addInterceptor(interceptor: Interceptor): void {
  interceptors.push(interceptor);
}

export function removeInterceptor(interceptor: Interceptor): void {
  const index = interceptors.indexOf(interceptor);
  if (index !== -1) {
    interceptors.splice(index, 1);
  }
}

// Add request retry logic
async function retryRequest<T>(
  url: string,
  options: RequestInit,
  maxRetries: number = 3,
  delay: number = 1000,
): Promise<T> {
  let lastError: Error | null = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await safeFetch<T>(url, options);
    } catch (e) {
      lastError = e as Error;
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay * Math.pow(2, i)));
      }
    }
  }

  throw lastError;
}

// Add request timeout
export async function fetchWithTimeout<T>(url: string, options: RequestInit & { timeout?: number } = {}): Promise<T> {
  const { timeout = 5000, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    return await safeFetch<T>(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Add request cancellation
export class RequestCanceller {
  private controller: AbortController;

  constructor() {
    this.controller = new AbortController();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(): void {
    this.controller.abort();
  }

  reset(): void {
    this.controller = new AbortController();
  }
}

// Add request progress tracking
export async function fetchWithProgress<T>(
  url: string,
  options: RequestInit & {
    onProgress?: (progress: number) => void;
  } = {},
): Promise<T> {
  const { onProgress, ...fetchOptions } = options;

  const response = await fetch(url, fetchOptions);
  const reader = response.body?.getReader();
  const contentLength = Number(response.headers.get("Content-Length")) || 0;

  if (!reader || !contentLength) {
    return response.json();
  }

  let receivedLength = 0;
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    chunks.push(value);
    receivedLength += value.length;

    if (onProgress) {
      onProgress(receivedLength / contentLength);
    }
  }

  const chunksAll = new Uint8Array(receivedLength);
  let position = 0;

  for (const chunk of chunks) {
    chunksAll.set(chunk, position);
    position += chunk.length;
  }

  return JSON.parse(new TextDecoder().decode(chunksAll));
}
