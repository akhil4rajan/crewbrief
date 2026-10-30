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
  Gap,
  HazardLibrary,
  HealthResponse,
  NegotiateResponse,
  RecordingUploadResult,
  Session,
  SessionDetail,
  SignOffRequest,
  SpeakerInfo,
  TranscriptSegment,
  User,
  UpdateSpeakerRequest,
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
  patchDraft: (id: string, body: ApplyPatchesRequest) =>
    request<ApplyPatchesResult>(`${s(id)}/draft`, { method: "PATCH", body }),
  dismissGap: (id: string, gapId: string, reason: string) =>
    request<Gap>(`${s(id)}/gaps/${enc(gapId)}/dismiss`, { method: "POST", body: { reason } }),

  endBriefing: (id: string) => request<Session>(`${s(id)}/end-briefing`, { method: "POST" }),
  resumeBriefing: (id: string) => request<Session>(`${s(id)}/resume-briefing`, { method: "POST" }),
  signOff: (id: string, body: SignOffRequest) => request<Session>(`${s(id)}/sign-off`, { method: "POST", body }),
  submit: (id: string) => request<Session>(`${s(id)}/submit`, { method: "POST" }),
  abandon: (id: string, body: AbandonRequest) => request<Session>(`${s(id)}/abandon`, { method: "POST", body }),

  finishClarifications: (id: string) => request<Session>(`${s(id)}/finish-clarifications`, { method: "POST" }),

  consent: (id: string) => request<Session>(`${s(id)}/consent`, { method: "POST" }),
  start: (id: string) => request<Session>(`${s(id)}/start`, { method: "POST" }),
  acknowledge: (id: string) => request<SessionDetail>(`${s(id)}/acknowledge`, { method: "POST" }),

  audit: (id: string) => request<AuditEntry[]>(`${s(id)}/audit`),
  diff: (id: string) => request<DraftDiff>(`${s(id)}/diff`),

  speakers: (id: string) => request<SpeakerInfo[]>(`${s(id)}/speakers`),
  updateSpeaker: (id: string, speakerId: string, body: UpdateSpeakerRequest) =>
    request<SpeakerInfo>(`${s(id)}/speakers/${enc(speakerId)}`, { method: "PUT", body }),

  negotiate: (id: string) => request<NegotiateResponse>(`${s(id)}/negotiate`, { baseUrl: config.gatewayUrl }),
  /** Upload a recorded briefing (gateway, Azure only; 501 `stt_unavailable_local` in local mode). */
  uploadRecording: (id: string, file: File) => {
    const body = new FormData();
    body.append("file", file, file.name);
    return request<RecordingUploadResult>(`${s(id)}/recording`, { method: "POST", body, baseUrl: config.gatewayUrl });
  },
};
