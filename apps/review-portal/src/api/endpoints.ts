import { config } from "../config";
import { request } from "./client";
import type {
  AbandonRequest,
  ApplyPatchesRequest,
  ApplyPatchesResult,
  AuditEntry,
  CreateSessionRequest,
  DevTokenResponse,
  DraftDiff,
  EditRateMetrics,
  Gap,
  HazardLibrary,
  HealthResponse,
  NegotiateResponse,
  Session,
  SessionDetail,
  SignOffRequest,
  TranscriptSegment,
  User,
  UserRole,
} from "./types";

const enc = encodeURIComponent;
const s = (id: string) => `/api/sessions/${enc(id)}`;

/** Typed wrappers for the form API and gateway (docs/api/contracts.md). */
export const api = {
  health: () => request<HealthResponse>("/healthz", { anonymous: true }),

  devUsers: () => request<User[]>("/api/auth/dev-users", { anonymous: true }),
  devToken: (userId: string) =>
    request<DevTokenResponse>("/api/auth/dev-token", { method: "POST", body: { user_id: userId }, anonymous: true }),
  me: (token?: string) => request<User>("/api/me", token === undefined ? {} : { token }),
  users: (role?: UserRole) => request<User[]>(role ? `/api/users?role=${enc(role)}` : "/api/users"),
  library: () => request<HazardLibrary>("/api/library"),

  sessions: (opts: { mine?: boolean } = {}) => request<Session[]>(opts.mine ? "/api/sessions?mine=true" : "/api/sessions"),
  createSession: (body: CreateSessionRequest) => request<SessionDetail>("/api/sessions", { method: "POST", body }),
  session: (id: string) => request<SessionDetail>(s(id)),
  transcript: (id: string) => request<TranscriptSegment[]>(`${s(id)}/transcript`),
  gaps: (id: string) => request<Gap[]>(`${s(id)}/gaps`),
  patchDraft: (id: string, body: ApplyPatchesRequest) =>
    request<ApplyPatchesResult>(`${s(id)}/draft`, { method: "PATCH", body }),
  dismissGap: (id: string, gapId: string, reason: string) =>
    request<Gap>(`${s(id)}/gaps/${enc(gapId)}/dismiss`, { method: "POST", body: { reason } }),

  endBriefing: (id: string) => request<Session>(`${s(id)}/end-briefing`, { method: "POST" }),
  resumeBriefing: (id: string) => request<Session>(`${s(id)}/resume-briefing`, { method: "POST" }),
  signOff: (id: string, body: SignOffRequest) => request<Session>(`${s(id)}/sign-off`, { method: "POST", body }),
  submit: (id: string) => request<Session>(`${s(id)}/submit`, { method: "POST" }),
  abandon: (id: string, body: AbandonRequest) => request<Session>(`${s(id)}/abandon`, { method: "POST", body }),

  // Crew-side calls (crew view).
  checkIn: (id: string, userId: string) =>
    request<SessionDetail>(`${s(id)}/check-in`, { method: "POST", body: { user_id: userId } }),
  consent: (id: string) => request<Session>(`${s(id)}/consent`, { method: "POST" }),
  start: (id: string) => request<Session>(`${s(id)}/start`, { method: "POST" }),
  acknowledge: (id: string) => request<SessionDetail>(`${s(id)}/acknowledge`, { method: "POST" }),

  audit: (id: string) => request<AuditEntry[]>(`${s(id)}/audit`),
  diff: (id: string) => request<DraftDiff>(`${s(id)}/diff`),
  editRate: () => request<EditRateMetrics>("/api/metrics/edit-rate"),

  negotiate: (id: string) => request<NegotiateResponse>(`${s(id)}/negotiate`, { baseUrl: config.gatewayUrl }),
};
