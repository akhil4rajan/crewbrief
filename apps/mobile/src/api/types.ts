/**
 * TypeScript mirror of the contracts in packages/schemas (Pydantic v2) and docs/api/contracts.md.
 * Hand-written so the app has no build step against the Python repo; keep in sync when the
 * schemas change (JSON Schema is exported by `python -m packages.schemas.export`).
 * Datetimes arrive as ISO-8601 strings.
 */

export type IsoDateTime = string;

// --- common -----------------------------------------------------------------------------

export type Source = "ai" | "human" | "system";

export interface EvidenceRef {
  segment_id: string;
  speaker_id?: string | null;
  start_ms: number;
  end_ms: number;
  quote: string;
}

export interface Provenance {
  source: Source;
  role?: string | null;
  model?: string | null;
  prompt_version?: string | null;
  evidence: EvidenceRef[];
  confidence: number;
  updated_by?: string | null;
  updated_at: IsoDateTime;
}

// --- users ------------------------------------------------------------------------------

export type UserRole = "crew" | "supervisor" | "safety_admin" | "service";

export interface User {
  id: string;
  name: string;
  email?: string | null;
  roles: UserRole[];
  crew_id?: string | null;
  employee_no?: string | null;
}

export interface DevTokenResponse {
  access_token: string;
  token_type: "bearer";
  user: User;
}

// --- library ----------------------------------------------------------------------------

export type Severity = "low" | "medium" | "high" | "critical";

export type ControlType =
  | "elimination"
  | "substitution"
  | "isolation"
  | "engineering"
  | "administrative"
  | "ppe";

export interface ControlDef {
  code: string;
  name: string;
  type: ControlType;
  description: string;
  keywords: string[];
}

export interface HazardDef {
  code: string;
  name: string;
  category: string;
  severity: Severity;
  description: string;
  keywords: string[];
  typical_controls: string[];
  references: string[];
}

export interface TaskTypeDef {
  code: string;
  name: string;
  keywords: string[];
  typical_hazards: string[];
}

export interface SiteConditionDef {
  code: string;
  name: string;
  keywords: string[];
  implies_hazards: string[];
}

export interface HazardLibrary {
  version: string;
  hazards: HazardDef[];
  controls: ControlDef[];
  task_types: TaskTypeDef[];
  site_conditions: SiteConditionDef[];
}

// --- session ----------------------------------------------------------------------------

export type SessionState =
  | "CREATED"
  | "BRIEFING"
  | "DRAFTING"
  | "GAP_CHECK"
  | "REVIEW"
  | "SIGNED"
  | "SUBMITTED"
  | "ABANDONED";

export const LIVE_STATES: readonly SessionState[] = ["BRIEFING", "DRAFTING", "GAP_CHECK"];

export type RecordingState = "idle" | "active" | "paused";

export interface Session {
  id: string;
  title: string;
  state: SessionState;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  created_by: string;
  supervisor_id?: string | null;
  crew_member_ids: string[];
  work_order_id?: string | null;
  task_type?: string | null;
  location?: string | null;
  recording: RecordingState;
  consent_acknowledged_at?: IsoDateTime | null;
  signed_by?: string | null;
  signed_at?: IsoDateTime | null;
  sign_off_comment?: string | null;
  submitted_at?: IsoDateTime | null;
  submission_ref?: string | null;
  abandon_reason?: string | null;
  ai_draft_revision?: number | null;
}

export interface CreateSessionRequest {
  title: string;
  work_order_id?: string | null;
  task_type?: string | null;
  location?: string | null;
  supervisor_id?: string | null;
  crew_member_ids: string[];
}

export interface SessionDetail {
  session: Session;
  draft: Draft;
  gaps: Gap[];
  transcript_count: number;
}

// --- form -------------------------------------------------------------------------------

export interface FieldValue<T = unknown> {
  value: T;
  provenance: Provenance;
}

export type HazardStatus = "present" | "unconfirmed" | "not_present";
export type HazardOrigin = "mentioned" | "task_typical" | "site_condition" | "human";
export type ControlStatus = "planned" | "in_place" | "proposed";

export interface JobDetails {
  title?: FieldValue | null;
  work_order_id?: FieldValue | null;
  task_type?: FieldValue | null;
  location?: FieldValue | null;
  description?: FieldValue | null;
  scheduled_start?: FieldValue | null;
}

export interface CrewEntry {
  user_id: string;
  name: string;
  role: string;
  checked_in_at?: IsoDateTime | null;
  acknowledged: boolean;
}

export interface TaskStep {
  id: string;
  order: number;
  description: string;
  provenance: Provenance;
}

export interface SiteCondition {
  id: string;
  code?: string | null;
  description: string;
  provenance: Provenance;
}

export interface ControlEntry {
  code: string;
  name: string;
  type: ControlType;
  status: ControlStatus;
  description: string;
  provenance: Provenance;
}

export interface HazardEntry {
  code: string;
  name: string;
  category: string;
  severity: Severity;
  status: HazardStatus;
  origin: HazardOrigin;
  description: string;
  controls: Record<string, ControlEntry>;
  provenance: Provenance;
}

export interface PpeItem {
  code: string;
  name: string;
  provenance: Provenance;
}

export interface EmergencyPlan {
  muster_point?: FieldValue | null;
  nearest_hospital?: FieldValue | null;
  first_aider?: FieldValue | null;
  communications?: FieldValue | null;
}

export interface Permit {
  id: string;
  type: string;
  reference: string;
  provenance: Provenance;
}

export interface Form {
  schema_version: string;
  job: JobDetails;
  crew: Record<string, CrewEntry>;
  tasks: Record<string, TaskStep>;
  site_conditions: Record<string, SiteCondition>;
  hazards: Record<string, HazardEntry>;
  ppe: Record<string, PpeItem>;
  emergency: EmergencyPlan;
  permits: Record<string, Permit>;
  notes?: FieldValue | null;
}

export interface Draft {
  session_id: string;
  revision: number;
  form: Form;
  updated_at?: IsoDateTime | null;
}

// --- patches ----------------------------------------------------------------------------

export type PatchOp = "add" | "replace" | "remove";

export interface FormPatch {
  id?: string;
  op: PatchOp;
  path: string;
  value?: unknown;
  provenance?: Partial<Provenance>;
}

export interface ApplyPatchesRequest {
  patches: FormPatch[];
  expected_revision?: number | null;
}

export interface RejectedPatch {
  patch: FormPatch;
  rule: string;
  reason: string;
}

export interface ApplyPatchesResult {
  revision: number;
  applied: FormPatch[];
  rejected: RejectedPatch[];
}

// --- gaps -------------------------------------------------------------------------------

export type GapKind =
  | "unsupported_field"
  | "high_risk_without_control"
  | "hazard_without_control"
  | "contradiction"
  | "missing_required_field"
  | "unconfirmed_hazard"
  | "low_confidence";

export type GapSeverity = "blocking" | "warning" | "info";
export type GapStatus = "open" | "resolved" | "dismissed";

export interface Gap {
  id: string;
  kind: GapKind;
  severity: GapSeverity;
  path: string;
  message: string;
  question?: string | null;
  status: GapStatus;
  created_at: IsoDateTime;
  resolved_at?: IsoDateTime | null;
  resolution?: string | null;
  asked_at?: IsoDateTime | null;
}

// --- transcript -------------------------------------------------------------------------

export type SegmentSource = "azure_stt" | "device_text" | "replay" | "voice_prompt";

export interface TranscriptSegment {
  id: string;
  session_id: string;
  seq: number;
  speaker_id: string;
  user_id?: string | null;
  speaker_name?: string | null;
  text: string;
  start_ms: number;
  end_ms: number;
  confidence: number;
  is_final: boolean;
  language: string;
  source: SegmentSource;
  filtered: boolean;
  filter_reason?: string | null;
  redacted: boolean;
  received_at: IsoDateTime;
}

// --- realtime events --------------------------------------------------------------------

export interface VoicePrompt {
  gap_id: string;
  text: string;
  priority: number;
  audio_b64?: string | null;
  audio_format?: string | null;
}

/** Payload per event type, as documented in packages/schemas/events.py. */
export interface EventPayloads {
  "session.state_changed": { from: SessionState; to: SessionState; reason?: string | null };
  "session.updated": Session;
  "recording.changed": { recording: RecordingState };
  "transcript.segment": TranscriptSegment;
  "form.patched": { revision: number; patches: FormPatch[]; source?: Source };
  "form.snapshot": Draft;
  "gaps.updated": { gaps: Gap[] };
  "voice.prompt": VoicePrompt;
  "presence.updated": { crew: CrewEntry[] };
  error: { code: string; message?: string };
}

export type EventType = keyof EventPayloads;

export type EventEnvelope = {
  [K in EventType]: { id: string; type: K; session_id: string; ts: IsoDateTime; payload: EventPayloads[K] };
}[EventType];

// --- device websocket protocol ----------------------------------------------------------

export type CaptureMode = "audio" | "text";

export type DeviceClientMessage =
  | { type: "start"; mode: CaptureMode; sample_rate?: number; encoding?: "pcm16"; device_id: string }
  | {
      type: "transcript";
      text: string;
      speaker_user_id: string;
      confidence: number;
      start_ms: number;
      end_ms: number;
    }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "end" }
  | { type: "ping" };

/** Gateway control frames that are not EventEnvelopes. */
export type DeviceControlMessage =
  | { type: "ready"; session_id: string; mode: CaptureMode }
  | { type: "pong" }
  | { type: "error"; code: string; message?: string };
