import { config } from "@/config";
import type {
  ApplyPatchesRequest,
  ApplyPatchesResult,
  CreateSessionRequest,
  DevTokenResponse,
  Draft,
  Gap,
  HazardLibrary,
  Session,
  SessionDetail,
  TranscriptSegment,
  User,
} from "./types";

const REQUEST_TIMEOUT_MS = 15_000;

/** RFC 7807 problem details as emitted by every CrewBrief service. */
export interface Problem {
  type?: string;
  title?: string;
  status: number;
  detail?: string;
  [extra: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail || problem.title || `Request failed (${problem.status})`);
    this.name = "ApiError";
    this.status = problem.status;
    this.code = problem.title || "error";
    this.problem = problem;
  }

  /** Network failure or timeout, i.e. no response from the server at all. */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

/** Human-readable message for any thrown value, for banners. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.isNetwork) return "Can't reach the CrewBrief server. Check signal and try again.";
    if (err.status === 401) return "Your sign-in has expired. Please sign in again.";
    if (err.status === 403) return err.problem.detail || "You don't have permission to do that.";
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

type TokenSource = () => string | null;
type UnauthorizedHandler = () => void;

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | boolean | undefined>;
  auth?: boolean;
  /** Use this token instead of the signed-in one (e.g. right after an Entra sign-in). */
  token?: string;
}

function newCorrelationId(): string {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

/**
 * Central Form API client. All requests carry the bearer token and a correlation id; every
 * non-2xx response is normalised to an ApiError built from the problem+json body.
 */
export class ApiClient {
  private tokenSource: TokenSource = () => null;
  private onUnauthorized: UnauthorizedHandler = () => undefined;

  constructor(private readonly baseUrl: string) {}

  configure(tokenSource: TokenSource, onUnauthorized: UnauthorizedHandler): void {
    this.tokenSource = tokenSource;
    this.onUnauthorized = onUnauthorized;
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Accept: "application/json, application/problem+json",
      "X-Correlation-Id": newCorrelationId(),
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const token = opts.auth === false ? null : (opts.token ?? this.tokenSource());
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
    } catch (err) {
      const detail = controller.signal.aborted ? "Request timed out" : errorText(err);
      throw new ApiError({ status: 0, title: "network_error", detail });
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
    const problem = await readProblem(res);
    if (res.status === 401 && token) this.onUnauthorized();
    throw new ApiError(problem);
  }

  // --- auth ----------------------------------------------------------------------------
  devUsers = () => this.request<User[]>("/api/auth/dev-users", { auth: false });
  devToken = (userId: string) =>
    this.request<DevTokenResponse>("/api/auth/dev-token", { method: "POST", body: { user_id: userId }, auth: false });
  me = (token?: string) => this.request<User>("/api/me", { token });
  users = (role?: string) => this.request<User[]>("/api/users", { query: { role } });

  // --- sessions ------------------------------------------------------------------------
  mySessions = () => this.request<Session[]>("/api/sessions", { query: { mine: true } });
  createSession = (body: CreateSessionRequest) =>
    this.request<SessionDetail>("/api/sessions", { method: "POST", body });
  session = (id: string) => this.request<SessionDetail>(`/api/sessions/${enc(id)}`);
  checkIn = (id: string, userId?: string) =>
    this.request<SessionDetail>(`/api/sessions/${enc(id)}/check-in`, {
      method: "POST",
      body: userId ? { user_id: userId } : {},
    });
  consent = (id: string) => this.request<Session>(`/api/sessions/${enc(id)}/consent`, { method: "POST" });
  acknowledge = (id: string) => this.request<SessionDetail>(`/api/sessions/${enc(id)}/acknowledge`, { method: "POST" });
  start = (id: string) => this.request<Session>(`/api/sessions/${enc(id)}/start`, { method: "POST" });
  endBriefing = (id: string) =>
    this.request<Session>(`/api/sessions/${enc(id)}/end-briefing`, { method: "POST" });

  // --- draft, transcript, gaps ---------------------------------------------------------
  draft = (id: string) => this.request<Draft>(`/api/sessions/${enc(id)}/draft`);
  patchDraft = (id: string, body: ApplyPatchesRequest) =>
    this.request<ApplyPatchesResult>(`/api/sessions/${enc(id)}/draft`, { method: "PATCH", body });
  transcript = (id: string) => this.request<TranscriptSegment[]>(`/api/sessions/${enc(id)}/transcript`);
  gaps = (id: string) => this.request<Gap[]>(`/api/sessions/${enc(id)}/gaps`);

  library = () => this.request<HazardLibrary>("/api/library");
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Network request failed";
}

async function readProblem(res: Response): Promise<Problem> {
  const fallback: Problem = { status: res.status, title: `http_${res.status}`, detail: res.statusText };
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object") {
      const obj = body as Record<string, unknown>;
      // FastAPI's own errors (e.g. 405) use {"detail": ...} rather than problem+json.
      const detail = typeof obj.detail === "string" ? obj.detail : fallback.detail;
      return { ...fallback, ...obj, status: res.status, detail };
    }
  } catch {
    // Non-JSON body (proxy error page etc.): keep the status-based fallback.
  }
  return fallback;
}

export const api = new ApiClient(config.apiBaseUrl);
