import { Check, ChevronDown, CircleCheck, Pencil } from "lucide-react";
import { useState, type ReactNode } from "react";
import { pointer } from "../api/jsonPointer";
import { useLibraryIndex, useUserDirectory } from "../api/queries";
import type { ControlEntry, FieldValue, HazardEntry, HazardStatus } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { config } from "../config";
import { formatDateTime, formatTime, humanize, STATE_LABEL } from "../format";
import { ActionButton, SignOffDialog, SubmitDialog, useSessionUpdate } from "./Actions";
import { useEditors, type SectionKey } from "./Editors";
import { CONTROL_TYPE_RANK } from "./Hazards";
import { actionPermissions, isLead } from "./permissions";
import { RiskChip, RiskLegend } from "./Risk";
import { useSessionUi } from "./SessionContext";

// ---------------------------------------------------------------- the document

/**
 * The JSEA as the crew lead signs it: the finished form, read-only, laid out like the company paper
 * form. Each section has an Edit link that opens a side panel; the evidence behind a value lives
 * only in that panel. Sign-off and submit sit in the declaration at the end.
 */
export function JseaDocument() {
  const { detail } = useSessionUi();
  const [dialog, setDialog] = useState<"sign-off" | "submit" | null>(null);
  const onSession = useSessionUpdate(detail.session.id, () => setDialog(null));
  return (
    <>
      <article className="jsea-doc" aria-label="Job Safety and Environmental Analysis form">
        <FormHeader />
        <PermitsSection />
        <HazardsSection />
        <PpeSection />
        <EmergencySection />
        <StepsSection />
        <CrewSection />
        <Declaration onAction={setDialog} />
      </article>
      {/* Dialogs sit outside the paper so they keep the app's colour scheme. */}
      {dialog === "sign-off" && <SignOffDialog detail={detail} onDone={onSession()} onClose={() => setDialog(null)} />}
      {dialog === "submit" && <SubmitDialog session={detail.session} onDone={onSession()} onClose={() => setDialog(null)} />}
    </>
  );
}

function EditLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="doc-edit no-print" aria-label={label} onClick={onClick}>
      <Pencil size={14} aria-hidden="true" />
      Edit
    </button>
  );
}

function OrgMark() {
  return (
    <svg className="org-mark" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <rect width="40" height="40" rx="6" fill="#1B2A35" />
      <path d="M7 27 L15 15 L21 23 L26 17 L33 27" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx="29" cy="11" r="3" fill="#F26B1D" />
    </svg>
  );
}

const fieldText = (f: FieldValue | null | undefined): string | null => {
  const v = f?.value;
  if (v === null || v === undefined || v === "") return null;
  return typeof v === "string" ? v : JSON.stringify(v);
};

/** A read-only form cell: label and value, or a muted "Not captured". */
function Cell({ label, value, path, stacked }: { label: string; value: ReactNode; path?: string; stacked?: boolean }) {
  return (
    <div className={`field-row${stacked ? " field-row-stacked" : ""}`} data-path={path} tabIndex={path ? -1 : undefined}>
      <span className="field-label">{label}</span>
      <div className="field-value">
        {value === null || value === undefined ? <span className="placeholder">Not captured</span> : <span>{value}</span>}
      </div>
    </div>
  );
}

/** Edit link for a section, shown only to people who may edit the draft. */
function useSectionEdit(section: SectionKey, label: string) {
  const { edit } = useSessionUi();
  const { openSection } = useEditors();
  return edit.allowed ? <EditLink label={`Edit ${label}`} onClick={() => openSection(section)} /> : undefined;
}

function FormHeader() {
  const { detail } = useSessionUi();
  const users = useUserDirectory();
  const { taskTypeName } = useLibraryIndex();
  const editLink = useSectionEdit("job", "job details");
  const s = detail.session;
  const job = detail.draft.form.job;
  const task = fieldText(job.task_type);
  const date = new Date(s.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  return (
    <header className="doc-header" data-path="/job" tabIndex={-1}>
      <div className="doc-brand">
        <span className="doc-org">
          <OrgMark />
          <span>
            <strong>{config.orgName}</strong>
            <span className="muted small">Health, Safety &amp; Environment</span>
          </span>
        </span>
        <span className="doc-formid">{config.formId}</span>
      </div>
      <div className="doc-title-row">
        <h2 className="doc-title">Job Safety &amp; Environmental Analysis (JSEA)</h2>
        {editLink}
      </div>
      <div className="doc-meta">
        <Cell label="Work order" path="/job/work_order_id" value={fieldText(job.work_order_id)} stacked />
        <Cell label="Date" value={date} stacked />
        <Cell label="Location / asset" path="/job/location" value={fieldText(job.location)} stacked />
        <Cell label="Task type" path="/job/task_type" value={task ? taskTypeName(task) : null} stacked />
        <Cell label="Crew leader" value={users.get(s.created_by)?.name ?? s.created_by} stacked />
        <Cell label="Status" value={STATE_LABEL[s.state]} stacked />
      </div>
      <div className="doc-scope">
        <Cell label="Scope of work" path="/job/description" value={fieldText(job.description)} />
      </div>
    </header>
  );
}

function DocSection({ n, title, path, note, action, children }: {
  n?: number;
  title: string;
  path: string;
  note?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = `doc-sec-${path.replace(/\W/g, "")}`;
  return (
    <section className="doc-section" aria-labelledby={id} data-path={path} tabIndex={-1}>
      <header className="doc-section-head">
        <h3 id={id}>
          {n !== undefined && <span className="doc-num">{n}</span>}
          {title}
        </h3>
        {(note || action) && (
          <span className="doc-section-side">
            {note && <span className="doc-section-note">{note}</span>}
            {action}
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- 1. permits & isolations

const CONFIRMED = new Set(["planned", "in_place"]);
const confirmed = (c: ControlEntry) => CONFIRMED.has(c.status);

interface Found {
  text: string;
  path: string;
}

/** The first confirmed control with one of these codes on a hazard that applies. */
function findControl(hazards: HazardEntry[], codes: string[]): Found | null {
  for (const h of hazards) {
    if (h.status === "not_present") continue;
    for (const c of Object.values(h.controls)) {
      if (codes.includes(c.code) && confirmed(c)) {
        return {
          text: `${c.name} · ${c.status === "in_place" ? "in place" : "planned"}`,
          path: `${pointer("hazards", h.code)}/controls/${pointer(c.code).slice(1)}`,
        };
      }
    }
  }
  return null;
}

const PERMIT_CHECKS: { label: string; controls: string[]; permit?: RegExp }[] = [
  { label: "Access permit / permit to work", controls: ["CT-ADM-ACCESS-PERMIT"], permit: /access|permit_to_work|work_permit/ },
  { label: "Switching instruction / isolation", controls: ["CT-ISO-HV-SWITCHING", "CT-ISO-LOTO", "CT-ISO-FUSES", "CT-ISO-SOLAR"], permit: /switching|isolation/ },
  { label: "Test before touch (prove de-energised)", controls: ["CT-ENG-TEST-DEAD"] },
  { label: "Earthing / equipotential bonding", controls: ["CT-ENG-EARTH", "CT-ENG-EQUIPOTENTIAL"] },
  { label: "Dial Before You Dig / services located", controls: ["CT-ADM-DBYD", "CT-ENG-CABLE-LOCATE"], permit: /dbyd|before_you_dig|dial/ },
  { label: "Traffic management", controls: ["CT-ADM-TMP", "CT-ADM-TRAFFIC-CONTROLLERS", "CT-ENG-TRAFFIC-DEVICES"], permit: /traffic/ },
];

function CheckMark({ on }: { on: boolean }) {
  return on ? (
    <span className="tick tick-on">
      <Check size={14} strokeWidth={3} aria-hidden="true" />
      <span className="sr-only">Yes</span>
    </span>
  ) : (
    <span className="tick">
      <span className="sr-only">No</span>
    </span>
  );
}

function PermitsSection() {
  const { detail } = useSessionUi();
  const form = detail.draft.form;
  const hazards = Object.values(form.hazards);
  const permits = Object.values(form.permits);
  return (
    <DocSection n={1} title="Permits & isolations" path="/permits" note="From the controls in section 2">
      <ul className="check-rows">
        {PERMIT_CHECKS.map((chk) => {
          const permit = chk.permit ? permits.find((p) => chk.permit!.test(p.type.toLowerCase())) : undefined;
          const found: Found | null =
            findControl(hazards, chk.controls) ??
            (permit ? { text: `${humanize(permit.type)}${permit.reference ? ` ${permit.reference}` : ""}`, path: pointer("permits", permit.id) } : null);
          return (
            <li key={chk.label} className={found ? "is-on" : undefined} data-path={found?.path} tabIndex={-1}>
              <CheckMark on={!!found} />
              <span className="check-label">{chk.label}</span>
              <span className="check-detail">{found ? found.text : <span className="muted">Not recorded</span>}</span>
            </li>
          );
        })}
      </ul>
    </DocSection>
  );
}

// ---------------------------------------------------------------- 2. hazards, risks, controls

const STATUS_TEXT: Record<HazardStatus, string> = { present: "Confirmed", unconfirmed: "To confirm", not_present: "Not applicable" };
const TYPE_TAG: Record<ControlEntry["type"], string> = {
  elimination: "Eliminate",
  substitution: "Substitute",
  isolation: "Isolate",
  engineering: "Engineer",
  administrative: "Admin",
  ppe: "PPE",
};

function HazardsSection() {
  const { detail } = useSessionUi();
  const [showTypical, setShowTypical] = useState(false);
  const [showNa, setShowNa] = useState(false);
  const risk = detail.risk ?? {};
  const byRisk = (a: HazardEntry, b: HazardEntry) =>
    (risk[b.code]?.before.score ?? 0) - (risk[a.code]?.before.score ?? 0) || a.name.localeCompare(b.name);

  const all = Object.values(detail.draft.form.hazards);
  const na = all.filter((h) => h.status === "not_present").sort(byRisk);
  const typical = all.filter((h) => h.status === "unconfirmed").sort(byRisk);
  const main = all.filter((h) => h.status === "present").sort(byRisk);

  let n = 0;
  const rows = (list: HazardEntry[]) => list.map((h) => <HazardRow key={h.code} n={++n} hazard={h} />);

  return (
    <DocSection n={2} title="Hazards, risks and controls" path="/hazards">
      <table className="hz-table">
        <thead>
          <tr>
            <th scope="col" className="hz-n">#</th>
            <th scope="col">Hazard</th>
            <th scope="col" className="hz-risk">Risk before</th>
            <th scope="col">Controls the crew stated</th>
            <th scope="col" className="hz-risk">Risk after</th>
            <th scope="col" className="hz-status">Status</th>
          </tr>
        </thead>
        <tbody>
          {main.length ? rows(main) : (
            <tr>
              <td colSpan={6} className="muted">No hazards confirmed yet.</td>
            </tr>
          )}
        </tbody>
        {typical.length > 0 && (
          <GroupBody label="Typical for this task, not confirmed" count={typical.length} open={showTypical} onToggle={() => setShowTypical((v) => !v)}>
            {rows(typical)}
          </GroupBody>
        )}
        {na.length > 0 && (
          <GroupBody label="Ruled out as not applicable" count={na.length} open={showNa} onToggle={() => setShowNa((v) => !v)}>
            {rows(na)}
          </GroupBody>
        )}
      </table>
      <RiskLegend />
    </DocSection>
  );
}

/** A collapsed group of rows. The rows stay rendered (hidden) so the print view can show them. */
function GroupBody({ label, count, open, onToggle, children }: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <tbody className="hz-group-head">
        <tr>
          <td colSpan={6}>
            <button type="button" className="disclosure-btn" aria-expanded={open} onClick={onToggle}>
              <ChevronDown size={16} aria-hidden="true" className="chev" />
              {label} ({count})
            </button>
          </td>
        </tr>
      </tbody>
      <tbody className={`hz-group${open ? "" : " is-collapsed"}`}>{children}</tbody>
    </>
  );
}

function HazardRow({ n, hazard }: { n: number; hazard: HazardEntry }) {
  const { detail, edit } = useSessionUi();
  const { openHazard } = useEditors();
  const r = detail.risk?.[hazard.code];
  const na = hazard.status === "not_present";
  const stated = Object.values(hazard.controls)
    .filter(confirmed)
    .sort((a, b) => CONTROL_TYPE_RANK[a.type] - CONTROL_TYPE_RANK[b.type] || a.name.localeCompare(b.name));

  return (
    <tr className={`hz-row${na ? " is-na" : ""}`} data-path={pointer("hazards", hazard.code)} tabIndex={-1} onClick={() => openHazard(hazard.code)}>
      <td className="hz-n" data-label="#">{n}</td>
      <td className="hz-name" data-label="Hazard">
        <span className="hz-title">{hazard.name}</span>
        <span className="hz-cat muted small">{humanize(hazard.category)}</span>
        {edit.allowed && <EditLink label={`Edit ${hazard.name}`} onClick={() => openHazard(hazard.code)} />}
      </td>
      <td className="hz-risk" data-label="Risk before">
        <RiskChip risk={r?.before} />
      </td>
      <td className="hz-controls" data-label="Controls">
        {na ? (
          <span className="muted">—</span>
        ) : stated.length ? (
          <ul>
            {stated.map((c) => (
              <li key={c.code}>
                <span className={`htag htag-${c.type}`}>{TYPE_TAG[c.type]}</span>
                <span>{c.name}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="warn-text">None stated</span>
        )}
      </td>
      <td className="hz-risk" data-label="Risk after">
        {na ? <span className="muted">—</span> : <RiskChip risk={r?.after} />}
      </td>
      <td className="hz-status" data-label="Status">
        <span className={`hz-st hz-st-${hazard.status}`}>{STATUS_TEXT[hazard.status]}</span>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------- 3. PPE

function PpeSection() {
  const { detail } = useSessionUi();
  const { library } = useLibraryIndex();
  const form = detail.draft.form;
  const recorded = new Map<string, string>();
  for (const p of Object.values(form.ppe)) recorded.set(p.code, p.name);
  for (const h of Object.values(form.hazards)) {
    if (h.status === "not_present") continue;
    for (const c of Object.values(h.controls)) {
      if (c.type === "ppe" && confirmed(c) && !recorded.has(c.code)) recorded.set(c.code, c.name);
    }
  }
  const listed = (library?.controls ?? []).filter((c) => c.type === "ppe").map((c) => ({ code: c.code, name: c.name }));
  for (const [code, name] of recorded) if (!listed.some((l) => l.code === code)) listed.push({ code, name });

  return (
    <DocSection n={3} title="Personal protective equipment" path="/ppe" note={`${recorded.size} required`}>
      <ul className="ppe-grid">
        {listed.map((p) => {
          const on = recorded.has(p.code);
          return (
            <li key={p.code} className={on ? "is-on" : undefined} data-path={on ? pointer("ppe", p.code) : undefined}>
              <CheckMark on={on} />
              <span>{p.name}</span>
            </li>
          );
        })}
      </ul>
    </DocSection>
  );
}

// ---------------------------------------------------------------- 4. emergency

function EmergencySection() {
  const { detail } = useSessionUi();
  const editLink = useSectionEdit("emergency", "emergency plan");
  const e = detail.draft.form.emergency;
  return (
    <DocSection n={4} title="Emergency plan" path="/emergency" action={editLink}>
      <div className="doc-fields">
        <Cell label="Muster point" path="/emergency/muster_point" value={fieldText(e.muster_point)} />
        <Cell label="Nearest hospital" path="/emergency/nearest_hospital" value={fieldText(e.nearest_hospital)} />
        <Cell label="First aider" path="/emergency/first_aider" value={fieldText(e.first_aider)} />
        <Cell label="Communications" path="/emergency/communications" value={fieldText(e.communications)} />
      </div>
    </DocSection>
  );
}

// ---------------------------------------------------------------- 5. steps & notes

function StepsSection() {
  const { detail } = useSessionUi();
  const editLink = useSectionEdit("notes", "notes");
  const form = detail.draft.form;
  const tasks = Object.values(form.tasks).sort((a, b) => a.order - b.order);
  const conditions = Object.values(form.site_conditions);
  return (
    <DocSection n={5} title="Job steps & site conditions" path="/tasks" action={editLink}>
      {tasks.length > 0 ? (
        <ol className="doc-steps">
          {tasks.map((t) => (
            <li key={t.id} data-path={pointer("tasks", t.id)} tabIndex={-1}>
              <span>{t.description}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted small">No job steps were recorded in the briefing.</p>
      )}
      {conditions.length > 0 && (
        <div className="doc-conditions" data-path="/site_conditions">
          <span className="field-label">Site conditions</span>
          <ul>
            {conditions.map((c) => (
              <li key={c.id}>{c.description}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="doc-fields">
        <Cell label="Notes" path="/notes" value={fieldText(form.notes)} />
      </div>
    </DocSection>
  );
}

// ---------------------------------------------------------------- 6. crew sign-on

function CrewSection() {
  const { detail, edit } = useSessionUi();
  const editLink = useSectionEdit("crew", "crew sign-on");
  const crew = Object.values(detail.draft.form.crew);
  return (
    <DocSection n={6} title="Crew sign-on" path="/crew" action={editLink}>
      <table className="doc-table crew-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Role</th>
            <th scope="col">Signed on</th>
            <th scope="col">Read the JSEA</th>
          </tr>
        </thead>
        <tbody>
          {crew.length === 0 ? (
            <tr>
              <td colSpan={4} className="muted">
                No one has signed on yet.{edit.allowed && " Use Edit to name the voices in the recording."}
              </td>
            </tr>
          ) : (
            crew.map((c) => (
              <tr key={c.user_id} data-path={pointer("crew", c.user_id)} tabIndex={-1}>
                <td data-label="Name">{c.name}</td>
                <td data-label="Role">{humanize(c.role || "crew")}</td>
                <td data-label="Signed on" className="num">{c.checked_in_at ? formatTime(c.checked_in_at) : "—"}</td>
                <td data-label="Read the JSEA">
                  {c.acknowledged ? (
                    <span className="ok-text inline-icon">
                      <Check size={14} aria-hidden="true" /> Acknowledged
                    </span>
                  ) : (
                    <span className="muted">Not yet</span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </DocSection>
  );
}

// ---------------------------------------------------------------- declaration

function Declaration({ onAction }: { onAction: (dialog: "sign-off" | "submit") => void }) {
  const { detail } = useSessionUi();
  const { user } = useAuth();
  const users = useUserDirectory();
  const s = detail.session;
  const perms = actionPermissions(user, s);
  const leadName = users.get(s.created_by)?.name ?? s.created_by;
  const signer = s.signed_by ? (users.get(s.signed_by)?.name ?? s.signed_by) : null;
  const lead = isLead(user, s);

  return (
    <section className="doc-declaration" aria-labelledby="doc-decl" data-path="/declaration" tabIndex={-1}>
      <h3 id="doc-decl">Declaration</h3>
      <p>
        I have discussed these hazards and controls with the crew. The controls listed are in place, or will be in place
        before work starts, and every crew member has had the chance to raise concerns and stop the job if conditions
        change.
      </p>
      <dl className="sig-grid">
        <div>
          <dt>Crew leader</dt>
          <dd>{leadName}</dd>
        </div>
        <div>
          <dt>Signature</dt>
          <dd className={signer ? "sig-signed" : "sig-empty"}>{signer ? `Signed electronically by ${signer}` : "Not signed yet"}</dd>
        </div>
        <div>
          <dt>Date and time</dt>
          <dd className="num">{s.signed_at ? formatDateTime(s.signed_at) : "—"}</dd>
        </div>
      </dl>
      {s.sign_off_comment && <p className="muted small">Comment: {s.sign_off_comment}</p>}
      {s.state === "SUBMITTED" && (
        <p className="ok-text inline-icon">
          <CircleCheck size={16} aria-hidden="true" />
          Submitted{s.submission_ref ? ` as ${s.submission_ref}` : ""} on {formatDateTime(s.submitted_at)}.
        </p>
      )}
      {lead && (s.state === "REVIEW" || s.state === "SIGNED") && (
        <div className="decl-actions no-print">
          {s.state === "REVIEW" ? (
            <ActionButton perm={perms.signOff} primary onClick={() => onAction("sign-off")}>
              Sign off as crew leader
            </ActionButton>
          ) : (
            <ActionButton perm={perms.submit} primary onClick={() => onAction("submit")}>
              Submit to safety system
            </ActionButton>
          )}
          {s.state === "REVIEW" && <span className="muted small">You can still edit the form until you sign.</span>}
        </div>
      )}
    </section>
  );
}
