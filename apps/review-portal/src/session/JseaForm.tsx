import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, CircleAlert, CircleCheck, OctagonAlert } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { api } from "../api/endpoints";
import { pointer } from "../api/jsonPointer";
import { qk, useLibraryIndex, useUserDirectory } from "../api/queries";
import type { ControlEntry, Gap, HazardEntry, HazardStatus, Provenance } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Drawer } from "../components/Drawer";
import { InlineError, Skeleton } from "../components/Feedback";
import { config } from "../config";
import { formatDateTime, formatTime, humanize, STATE_LABEL } from "../format";
import { ActionButton, SignOffDialog, SubmitDialog, useSessionUpdate } from "./Actions";
import { DismissDialog } from "./Decisions";
import { FieldRow } from "./FieldRow";
import { CONTROL_TYPE_RANK, HazardEditor } from "./Hazards";
import { actionPermissions, isLead } from "./permissions";
import { QuietProvenance } from "./Provenance";
import { RiskChip, RiskLegend } from "./Risk";
import { flash, useSessionUi } from "./SessionContext";
import { SpeakerRow } from "./Speakers";

// ---------------------------------------------------------------- gaps on the document

const isOpen = (g: Gap) => g.status === "open";
const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
/** Sections that show their own flags; open gaps elsewhere are listed in the summary. */
const SHOWN_PREFIXES = ["/hazards", "/job", "/emergency", "/crew", "/permits", "/ppe", "/tasks", "/notes"];

interface DocActions {
  requestDismiss: (gap: Gap) => void;
  openHazard: (code: string) => void;
}
const DocCtx = createContext<DocActions | null>(null);
function useDoc(): DocActions {
  const ctx = useContext(DocCtx);
  if (!ctx) throw new Error("useDoc outside the JSEA document");
  return ctx;
}

/** One open item as an inline flag with the actions that settle it. */
function GapFlag({ gap, actions }: { gap: Gap; actions?: ReactNode }) {
  const { detail } = useSessionUi();
  const { user } = useAuth();
  const { requestDismiss } = useDoc();
  const canDismiss = actionPermissions(user, detail.session).dismissGap.allowed;
  const Icon = gap.severity === "blocking" ? OctagonAlert : CircleAlert;
  return (
    <div className={`doc-flag doc-flag-${gap.severity}`} data-flag={gap.severity}>
      <span className="doc-flag-text">
        <Icon size={16} aria-hidden="true" />
        <span>
          <span className="sr-only">{gap.severity === "blocking" ? "Blocks sign-off: " : "Check: "}</span>
          {gap.message}
        </span>
      </span>
      {(actions || canDismiss) && (
        <span className="doc-flag-actions no-print" onClick={(e) => e.stopPropagation()}>
          {actions}
          {canDismiss && (
            <button type="button" className="btn btn-ghost btn-small" onClick={() => requestDismiss(gap)}>
              Dismiss
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/** Flags for every open gap at or under `prefix`. */
function PathFlags({ prefix, exact }: { prefix: string; exact?: boolean }) {
  const { detail } = useSessionUi();
  const gaps = detail.gaps.filter((g) => isOpen(g) && (exact ? g.path === prefix : under(g.path, prefix)));
  if (!gaps.length) return null;
  return (
    <div className="doc-flags">
      {gaps.map((g) => (
        <GapFlag key={g.id} gap={g} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the document

/**
 * The JSEA as the crew lead signs it: a prefilled company form, top to bottom. AI details
 * (quotes, confidence, model) sit behind the small quote buttons and the hazard side panel.
 */
export function JseaDocument() {
  const { detail } = useSessionUi();
  const [hazardCode, setHazardCode] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<Gap | null>(null);
  const hazard = hazardCode ? detail.draft.form.hazards[hazardCode] : undefined;

  return (
    <DocCtx.Provider value={{ requestDismiss: setDismissing, openHazard: setHazardCode }}>
      <DecisionSummary />
      <article className="jsea-doc" aria-label="Job Safety and Environmental Analysis form">
        <FormHeader />
        <PermitsSection />
        <HazardsSection />
        <PpeSection />
        <EmergencySection />
        <StepsSection />
        <CrewSection />
        <Declaration />
      </article>
      {hazard && (
        <Drawer title={hazard.name} onClose={() => setHazardCode(null)}>
          <HazardEditor hazard={hazard} risk={detail.risk?.[hazard.code]} />
        </Drawer>
      )}
      {dismissing && <DismissDialog gap={dismissing} sessionId={detail.session.id} onClose={() => setDismissing(null)} />}
    </DocCtx.Provider>
  );
}

function DecisionSummary() {
  const { detail } = useSessionUi();
  const { user } = useAuth();
  const open = detail.gaps.filter(isOpen);
  if (detail.session.state !== "REVIEW" || !isLead(user, detail.session)) return null;
  const blocking = open.filter((g) => g.severity === "blocking");
  const orphans = open.filter((g) => !SHOWN_PREFIXES.some((p) => under(g.path, p)));

  const goToFirst = () => {
    const el =
      document.querySelector<HTMLElement>('.jsea-doc [data-flag="blocking"]') ??
      document.querySelector<HTMLElement>(".jsea-doc [data-flag]");
    const target = el?.closest<HTMLElement>("[data-flag-host]") ?? el;
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    flash(target);
  };

  const n = blocking.length;
  return (
    <section className={`doc-summary${n ? " doc-summary-attn" : ""} no-print`} aria-label="Items that need your decision">
      <div className="doc-summary-main">
        {n ? <OctagonAlert size={20} aria-hidden="true" /> : <CircleCheck size={20} aria-hidden="true" />}
        <p>
          {n ? (
            <>
              <strong>
                {n} {n === 1 ? "item needs" : "items need"} your decision
              </strong>{" "}
              before you can sign off. They are flagged on the form.
            </>
          ) : (
            <>
              <strong>Nothing blocks sign-off.</strong>{" "}
              {open.length ? `${open.length} lower-priority ${open.length === 1 ? "note is" : "notes are"} flagged on the form.` : "Read the form through, then sign the declaration at the end."}
            </>
          )}
        </p>
        {open.length > 0 && (
          <button type="button" className="btn btn-secondary btn-small" onClick={goToFirst}>
            Show {n ? "first item" : "first note"}
          </button>
        )}
      </div>
      {orphans.length > 0 && (
        <div className="doc-flags">
          {orphans.map((g) => (
            <GapFlag key={g.id} gap={g} />
          ))}
        </div>
      )}
    </section>
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

function StaticCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field-row field-row-stacked">
      <span className="field-label">{label}</span>
      <div className="field-value">
        <span>{children}</span>
      </div>
    </div>
  );
}

function FormHeader() {
  const { detail } = useSessionUi();
  const users = useUserDirectory();
  const { library, taskTypeName } = useLibraryIndex();
  const s = detail.session;
  const job = detail.draft.form.job;
  const taskOptions = (library?.task_types ?? []).map((t) => ({ value: t.code, label: t.name }));
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
      <h2 className="doc-title">Job Safety &amp; Environmental Analysis (JSEA)</h2>
      <div className="doc-meta">
        <FieldRow label="Work order" path="/job/work_order_id" field={job.work_order_id} stacked>
          <PathFlags prefix="/job/work_order_id" />
        </FieldRow>
        <StaticCell label="Date">{date}</StaticCell>
        <FieldRow label="Location / asset" path="/job/location" field={job.location} stacked>
          <PathFlags prefix="/job/location" />
        </FieldRow>
        <FieldRow
          label="Task type"
          path="/job/task_type"
          field={job.task_type}
          options={taskOptions}
          display={(v) => taskTypeName(String(v))}
          stacked
        >
          <PathFlags prefix="/job/task_type" />
        </FieldRow>
        <StaticCell label="Crew leader">{users.get(s.created_by)?.name ?? s.created_by}</StaticCell>
        <StaticCell label="Status">{STATE_LABEL[s.state]}</StaticCell>
      </div>
      <div className="doc-scope">
        <FieldRow label="Scope of work" path="/job/description" field={job.description} multiline>
          <PathFlags prefix="/job/description" />
        </FieldRow>
      </div>
      <PathFlags prefix="/job" exact />
    </header>
  );
}

function DocSection({ n, title, path, note, children }: {
  n?: number;
  title: string;
  path: string;
  note?: ReactNode;
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
        {note && <span className="doc-section-note">{note}</span>}
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
  provenance: Provenance;
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
          provenance: c.provenance,
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
    <DocSection n={1} title="Permits & isolations" path="/permits">
      <ul className="check-rows">
        {PERMIT_CHECKS.map((chk) => {
          const permit = chk.permit ? permits.find((p) => chk.permit!.test(p.type.toLowerCase())) : undefined;
          const found: Found | null =
            findControl(hazards, chk.controls) ??
            (permit
              ? { text: `${humanize(permit.type)}${permit.reference ? ` ${permit.reference}` : ""}`, path: pointer("permits", permit.id), provenance: permit.provenance }
              : null);
          return (
            <li key={chk.label} className={found ? "is-on" : undefined} data-path={found?.path} tabIndex={-1}>
              <CheckMark on={!!found} />
              <span className="check-label">{chk.label}</span>
              <span className="check-detail">
                {found ? found.text : <span className="muted">Not recorded</span>}
              </span>
              <span className="check-ev">{found && <QuietProvenance provenance={found.provenance} />}</span>
            </li>
          );
        })}
      </ul>
      <PathFlags prefix="/permits" />
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
  const { detail, edit } = useSessionUi();
  const [showTypical, setShowTypical] = useState(false);
  const [showNa, setShowNa] = useState(false);
  const risk = detail.risk ?? {};
  const open = detail.gaps.filter(isOpen);
  const gapsFor = (h: HazardEntry) => open.filter((g) => under(g.path, pointer("hazards", h.code)));
  const blocks = (h: HazardEntry) => gapsFor(h).some((g) => g.severity === "blocking");
  const byRisk = (a: HazardEntry, b: HazardEntry) =>
    (risk[b.code]?.before.score ?? 0) - (risk[a.code]?.before.score ?? 0) || a.name.localeCompare(b.name);

  const all = Object.values(detail.draft.form.hazards);
  const na = all.filter((h) => h.status === "not_present").sort(byRisk);
  const typical = all.filter((h) => h.status === "unconfirmed" && !blocks(h)).sort(byRisk);
  const main = all.filter((h) => !na.includes(h) && !typical.includes(h)).sort(byRisk);

  let n = 0;
  const rows = (list: HazardEntry[]) => list.map((h) => <HazardRow key={h.code} n={++n} hazard={h} gaps={gapsFor(h)} />);

  return (
    <DocSection
      n={2}
      title="Hazards, risks and controls"
      path="/hazards"
      note={edit.allowed ? "Select a hazard to edit it or see the evidence" : undefined}
    >
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
          <GroupBody label="Also typical for this task" count={typical.length} open={showTypical} onToggle={() => setShowTypical((v) => !v)}>
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

function HazardRow({ n, hazard, gaps }: { n: number; hazard: HazardEntry; gaps: Gap[] }) {
  const { detail, edit, applyEdit, editing, humanProvenance } = useSessionUi();
  const { openHazard } = useDoc();
  const r = detail.risk?.[hazard.code];
  const base = pointer("hazards", hazard.code);
  const na = hazard.status === "not_present";
  const stated = Object.values(hazard.controls)
    .filter(confirmed)
    .sort((a, b) => CONTROL_TYPE_RANK[a.type] - CONTROL_TYPE_RANK[b.type] || a.name.localeCompare(b.name));
  const severity = gaps.some((g) => g.severity === "blocking") ? "blocking" : gaps.length ? "warning" : null;

  const decide = (status: HazardStatus) =>
    void applyEdit([
      { op: "replace", path: `${base}/status`, value: status, provenance: humanProvenance() },
      { op: "replace", path: `${base}/provenance`, value: humanProvenance(hazard.provenance), provenance: humanProvenance() },
    ]);

  const actionsFor = (g: Gap) => {
    if (!edit.allowed) return undefined;
    if (g.kind === "unconfirmed_hazard") {
      return (
        <>
          <button type="button" className="btn btn-secondary btn-small" disabled={editing} onClick={() => decide("not_present")}>
            Not applicable
          </button>
          <button type="button" className="btn btn-secondary btn-small" disabled={editing} onClick={() => decide("present")}>
            Confirm present
          </button>
        </>
      );
    }
    if (g.kind === "high_risk_without_control" || g.kind === "hazard_without_control") {
      return (
        <button type="button" className="btn btn-secondary btn-small" onClick={() => openHazard(hazard.code)}>
          Add control
        </button>
      );
    }
    return undefined;
  };

  return (
    <>
      <tr
        className={`hz-row${na ? " is-na" : ""}${severity ? ` has-flag flag-${severity}` : ""}`}
        data-path={base}
        data-flag-host=""
        tabIndex={-1}
        onClick={() => openHazard(hazard.code)}
      >
        <td className="hz-n" data-label="#">{n}</td>
        <td className="hz-name" data-label="Hazard">
          <button type="button" className="hz-open" onClick={(e) => { e.stopPropagation(); openHazard(hazard.code); }}>
            {hazard.name}
          </button>
          <span className="hz-cat muted small">{humanize(hazard.category)}</span>
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
      {gaps.length > 0 && (
        <tr className={`hz-flag-row flag-${severity}`}>
          <td colSpan={6}>
            {gaps.map((g) => (
              <GapFlag key={g.id} gap={g} actions={actionsFor(g)} />
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------- 3. PPE

function PpeSection() {
  const { detail } = useSessionUi();
  const { library } = useLibraryIndex();
  const form = detail.draft.form;
  const recorded = new Map<string, { name: string; provenance: Provenance }>();
  for (const p of Object.values(form.ppe)) recorded.set(p.code, { name: p.name, provenance: p.provenance });
  for (const h of Object.values(form.hazards)) {
    if (h.status === "not_present") continue;
    for (const c of Object.values(h.controls)) {
      if (c.type === "ppe" && confirmed(c) && !recorded.has(c.code)) recorded.set(c.code, { name: c.name, provenance: c.provenance });
    }
  }
  const listed = (library?.controls ?? []).filter((c) => c.type === "ppe").map((c) => ({ code: c.code, name: c.name }));
  for (const [code, v] of recorded) if (!listed.some((l) => l.code === code)) listed.push({ code, name: v.name });

  return (
    <DocSection n={3} title="Personal protective equipment" path="/ppe" note={`${recorded.size} required`}>
      <ul className="ppe-grid">
        {listed.map((p) => {
          const on = recorded.get(p.code);
          return (
            <li key={p.code} className={on ? "is-on" : undefined} data-path={on ? pointer("ppe", p.code) : undefined}>
              <CheckMark on={!!on} />
              <span>{p.name}</span>
              {on && <QuietProvenance provenance={on.provenance} />}
            </li>
          );
        })}
      </ul>
      <PathFlags prefix="/ppe" />
    </DocSection>
  );
}

// ---------------------------------------------------------------- 4. emergency

function EmergencySection() {
  const { detail } = useSessionUi();
  const e = detail.draft.form.emergency;
  const rows: [string, string, typeof e.muster_point][] = [
    ["Muster point", "/emergency/muster_point", e.muster_point],
    ["Nearest hospital", "/emergency/nearest_hospital", e.nearest_hospital],
    ["First aider", "/emergency/first_aider", e.first_aider],
    ["Communications", "/emergency/communications", e.communications],
  ];
  return (
    <DocSection n={4} title="Emergency plan" path="/emergency">
      <div className="doc-fields">
        {rows.map(([label, path, field]) => (
          <FieldRow key={path} label={label} path={path} field={field}>
            <PathFlags prefix={path} />
          </FieldRow>
        ))}
      </div>
      <PathFlags prefix="/emergency" exact />
    </DocSection>
  );
}

// ---------------------------------------------------------------- 5. steps & notes

function StepsSection() {
  const { detail } = useSessionUi();
  const form = detail.draft.form;
  const tasks = Object.values(form.tasks).sort((a, b) => a.order - b.order);
  const conditions = Object.values(form.site_conditions);
  return (
    <DocSection n={5} title="Job steps & site conditions" path="/tasks">
      {tasks.length > 0 ? (
        <ol className="doc-steps">
          {tasks.map((t) => (
            <li key={t.id} data-path={pointer("tasks", t.id)} tabIndex={-1}>
              <span>{t.description}</span>
              <QuietProvenance provenance={t.provenance} />
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
              <li key={c.id}>
                {c.description} <QuietProvenance provenance={c.provenance} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="doc-fields">
        <FieldRow label="Notes" path="/notes" field={detail.draft.form.notes} multiline>
          <PathFlags prefix="/notes" />
        </FieldRow>
      </div>
      <PathFlags prefix="/tasks" />
    </DocSection>
  );
}

// ---------------------------------------------------------------- 6. crew sign-on

function CrewSection() {
  const { detail, edit } = useSessionUi();
  const crew = Object.values(detail.draft.form.crew);
  const speakers = useQuery({ queryKey: qk.speakers(detail.session.id), queryFn: () => api.speakers(detail.session.id) });
  return (
    <DocSection n={6} title="Crew sign-on" path="/crew">
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
              <td colSpan={4} className="muted">No one has signed on yet. Name a voice below to add them.</td>
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
      <PathFlags prefix="/crew" />
      <div className="doc-voices no-print">
        <h4 className="doc-subhead">Voices in the recording</h4>
        {speakers.isPending && <Skeleton lines={2} height={32} />}
        {speakers.isError && <InlineError error={speakers.error} onRetry={() => void speakers.refetch()} />}
        {speakers.data?.length === 0 && <p className="muted small">No voices were separated in this briefing.</p>}
        {speakers.data && speakers.data.length > 0 && (
          <ul className="speaker-rows">
            {speakers.data.map((sp) => (
              <SpeakerRow key={sp.speaker_id} sessionId={detail.session.id} speaker={sp} canEdit={edit.allowed} />
            ))}
          </ul>
        )}
      </div>
    </DocSection>
  );
}

// ---------------------------------------------------------------- declaration

function Declaration() {
  const { detail } = useSessionUi();
  const { user } = useAuth();
  const users = useUserDirectory();
  const [dialog, setDialog] = useState<"sign-off" | "submit" | null>(null);
  const onSession = useSessionUpdate(detail.session.id, () => setDialog(null));
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
            <ActionButton perm={perms.signOff} primary onClick={() => setDialog("sign-off")}>
              Sign off as crew leader
            </ActionButton>
          ) : (
            <ActionButton perm={perms.submit} primary onClick={() => setDialog("submit")}>
              Submit to safety system
            </ActionButton>
          )}
          {s.state === "REVIEW" && <span className="muted small">You can still edit the form until you sign.</span>}
        </div>
      )}
      {dialog === "sign-off" && <SignOffDialog detail={detail} onDone={onSession()} onClose={() => setDialog(null)} />}
      {dialog === "submit" && <SubmitDialog session={s} onDone={onSession()} onClose={() => setDialog(null)} />}
    </section>
  );
}

