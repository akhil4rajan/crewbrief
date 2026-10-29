/**
 * TypeScript mirror of the Pydantic contracts in packages/schemas.
 * Field names match the Python models exactly (snake_case, dict-keyed collections), so
 * JSON-Pointer paths such as `/hazards/HZ-ELEC-LV/controls/CT-ISO-LOTO` work unchanged.
 * Datetimes arrive as ISO-8601 strings.
 */

export type IsoDateTime = string;

// --- common.py --------------------------------------------------------------

export type Source = "ai" | "human" | "system";

export interface EvidenceRef {
  segment_id: string;
  speaker_id: string | null;
  start_ms: number;
  end_ms: number;
  quote: string;
}

export interface Provenance {
  source: Source;
  role: string | null;
  model: string | null;
  prompt_version: string | null;
  evidence: EvidenceRef[];
  confidence: number;
  updated_by: string | null;
  updated_at: IsoDateTime;
}

// --- users.py ---------------------------------------------------------------

export type UserRole = "crew" | "supervisor" | "safety_admin" | "service";

export interface User {
  id: string;
  name: string;
  email: string | null;
  roles: UserRole[];
  crew_id: string | null;
  employee_no: string | null;
}

export interface DevTokenResponse {
  access_token: string;
  token_type: "bearer";
  user: User;
}

// --- library.py -------------------------------------------------------------

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

export interface SafetyDocument {
  id: string;
  title: string;
  path: string;
  hazard_codes: string[];
  control_codes: string[];
}

export interface HazardLibrary {
  version: string;
  hazards: HazardDef[];
  controls: ControlDef[];
  task_types: TaskTypeDef[];
  site_conditions: SiteConditionDef[];
  documents: SafetyDocument[];
}

// --- form.py ----------------------------------------------------------------

export interface FieldValue<T = unknown> {
  value: T;
  provenance: Provenance;
}

export type HazardStatus = "present" | "unconfirmed" | "not_present";
export type HazardOrigin = "mentioned" | "task_typical" | "site_condition" | "human";
export type ControlStatus = "planned" | "in_place" | "proposed";

export interface JobDetails {
  title: FieldValue | null;
  work_order_id: FieldValue | null;
  task_type: FieldValue | null;
  location: FieldValue | null;
  description: FieldValue | null;
  scheduled_start: FieldValue | null;
}

export interface CrewEntry {
  user_id: string;
  name: string;
  role: string;
  checked_in_at: IsoDateTime | null;
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
  code: string | null;
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
  muster_point: FieldValue | null;
  nearest_hospital: FieldValue | null;
  first_aider: FieldValue | null;
  communications: FieldValue | null;
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
  notes: FieldValue | null;
}

export interface Draft {
  session_id: string;
  revision: number;
  form: Form;
  updated_at: IsoDateTime | null;
}

// --- session.py -------------------------------------------------------------

export type SessionState =
  | "CREATED"
  | "BRIEFING"
  | "DRAFTING"
  | "GAP_CHECK"
  | "REVIEW"
  | "SIGNED"
  | "SUBMITTED"
  | "ABANDONED";

export type RecordingState = "idle" | "active" | "paused";

export interface Session {
  id: string;
  title: string;
  state: SessionState;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  created_by: string;
  supervisor_id: string | null;
  crew_member_ids: string[];
  work_order_id: string | null;
  task_type: string | null;
  location: string | null;
  recording: RecordingState;
  consent_acknowledged_at: IsoDateTime | null;
  signed_by: string | null;
  signed_at: IsoDateTime | null;
  sign_off_comment: string | null;
  submitted_at: IsoDateTime | null;
  submission_ref: string | null;
  abandon_reason: string | null;
  ai_draft_revision: number | null;
}

export interface CreateSessionRequest {
  title: string;
  work_order_id?: string | null;
  task_type?: string | null;
  location?: string | null;
  supervisor_id?: string | null;
  crew_member_ids?: string[];
}

export interface SignOffRequest {
  comment?: string | null;
  override_blocking_gaps?: boolean;
  override_justification?: string | null;
}

export interface AbandonRequest {
  reason: string;
}

export interface SessionDetail {
  session: Session;
  draft: Draft;
  gaps: Gap[];
  transcript_count: number;
}

// --- gaps.py ----------------------------------------------------------------

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
  question: string | null;
  status: GapStatus;
  created_at: IsoDateTime;
  resolved_at: IsoDateTime | null;
  resolution: string | null;
  asked_at: IsoDateTime | null;
}

// --- transcript.py ----------------------------------------------------------

export type SegmentSource = "azure_stt" | "device_text" | "replay" | "voice_prompt";

export interface TranscriptSegment {
  id: string;
  session_id: string;
  seq: number;
  speaker_id: string;
  user_id: string | null;
  speaker_name: string | null;
  text: string;
  start_ms: number;
  end_ms: number;
  confidence: number;
  is_final: boolean;
  language: string;
  source: SegmentSource;
  filtered: boolean;
  filter_reason: string | null;
  redacted: boolean;
  received_at: IsoDateTime;
}

// --- patches.py -------------------------------------------------------------

export type PatchOp = "add" | "replace" | "remove";

export interface FormPatch {
  id?: string;
  op: PatchOp;
  path: string;
  value?: unknown;
  provenance?: Partial<Provenance>;
}

export interface RejectedPatch {
  patch: FormPatch;
  rule: string;
  reason: string;
}

export interface ApplyPatchesRequest {
  patches: FormPatch[];
  expected_revision: number | null;
}

export interface ApplyPatchesResult {
  revision: number;
  applied: FormPatch[];
  rejected: RejectedPatch[];
}

// --- audit.py ---------------------------------------------------------------

export type ActorType = "user" | "service" | "system";

export type AuditAction =
  | "session.created"
  | "session.transition"
  | "crew.checked_in"
  | "recording.changed"
  | "transcript.segments_received"
  | "form.patch_applied"
  | "form.patch_rejected"
  | "form.human_edit"
  | "gaps.updated"
  | "gap.dismissed"
  | "voice.prompt"
  | "role.invoked"
  | "session.signed_off"
  | "session.gap_override"
  | "session.submitted"
  | "session.abandoned";

export interface AuditEntry {
  id: string;
  session_id: string;
  ts: IsoDateTime;
  actor_id: string;
  actor_type: ActorType;
  action: AuditAction;
  path: string | null;
  before: unknown;
  after: unknown;
  model: string | null;
  prompt_version: string | null;
  details: Record<string, unknown>;
}

// --- diff + metrics (form API responses without a named Pydantic model) ----

export interface DiffChange {
  path: string;
  op: PatchOp;
  before: unknown;
  after: unknown;
  role: string | null;
}

export interface DraftDiff {
  ai_revision: number | null;
  final_revision: number;
  changes: DiffChange[];
}

export interface FieldEditRate {
  path_pattern: string;
  ai_filled: number;
  edited: number;
  edit_rate: number;
  /** Values the AI missed and a person added (a recall signal). */
  added_by_human?: number;
}

export interface RoleEditRate {
  role: string;
  ai_filled: number;
  edited: number;
  edit_rate: number;
}

export interface EditRateMetrics {
  sessions: number;
  fields: FieldEditRate[];
  roles: RoleEditRate[];
}

// --- roles.py / events.py ---------------------------------------------------

export interface VoicePrompt {
  gap_id: string;
  text: string;
  priority: number;
  audio_b64: string | null;
  audio_format: string | null;
}

export type EventType =
  | "session.state_changed"
  | "session.updated"
  | "recording.changed"
  | "transcript.segment"
  | "form.patched"
  | "form.snapshot"
  | "gaps.updated"
  | "voice.prompt"
  | "presence.updated"
  | "error";

export interface EventEnvelope<P = Record<string, unknown>> {
  id: string;
  type: EventType;
  session_id: string;
  ts: IsoDateTime;
  payload: P;
}

export interface FormPatchedPayload {
  revision: number;
  patches: FormPatch[];
  source?: Source | string;
}

export interface StateChangedPayload {
  from: SessionState;
  to: SessionState;
  reason?: string | null;
}

export interface NegotiateResponse {
  url: string;
}

export interface HealthResponse {
  status: string;
  service: string;
  mode: "local" | "azure";
}

/** RFC 7807 problem+json body as produced by packages.common.app. */
export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  correlation_id?: string;
  [extra: string]: unknown;
}
