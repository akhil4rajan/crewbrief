import { config } from "../config";
import type { Problem } from "./types";

/** An HTTP failure, carrying the RFC 7807 problem body when the service sent one. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem | null;

  constructor(status: number, problem: Problem | null, fallback: string) {
    super(problem?.detail || problem?.title || fallback);
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
  }

  get correlationId(): string | undefined {
    return this.problem?.correlation_id;
  }

  get code(): string | undefined {
    return this.problem?.title;
  }
}

type TokenProvider = () => Promise<string | null>;

let tokenProvider: TokenProvider = async () => null;
let onUnauthorized: () => void = () => undefined;

/** Wired by the AuthProvider so every request carries the current bearer token. */
export function configureAuth(provider: TokenProvider, unauthorized: () => void): void {
  tokenProvider = provider;
  onUnauthorized = unauthorized;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Override the base URL (the gateway lives on a different origin from the form API). */
  baseUrl?: string;
  /** Use this token instead of the signed-in user's. */
  token?: string | null;
  anonymous?: boolean;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json, application/problem+json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (!opts.anonymous) {
    const token = opts.token !== undefined ? opts.token : await tokenProvider();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${opts.baseUrl ?? config.apiBaseUrl}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, { title: "network_error", detail: "Cannot reach the CrewBrief service" }, "Network error");
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    if (response.status === 401 && !opts.anonymous && opts.token === undefined) onUnauthorized();
    const problem = body && typeof body === "object" ? (body as Problem) : null;
    throw new ApiError(response.status, problem, `${response.status} ${response.statusText}`);
  }
  return body as T;
}
