import { Plus, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { pointer } from "../api/jsonPointer";
import { useLibrary } from "../api/queries";
import type { ControlEntry, ControlStatus, ControlType, HazardEntry, HazardRisk, HazardStatus, Severity } from "../api/types";
import { Modal } from "../components/Modal";
import { humanize, slugify } from "../format";
import { EvidenceList, ProvenanceMeta } from "./Provenance";
import { RiskChip } from "./Risk";
import { useSessionUi } from "./SessionContext";

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const STATUS_ORDER: Record<HazardStatus, number> = { present: 0, unconfirmed: 1, not_present: 2 };
const HAZARD_STATUSES: { value: HazardStatus; label: string }[] = [
  { value: "present", label: "Present" },
  { value: "unconfirmed", label: "Unconfirmed" },
  { value: "not_present", label: "Not applicable" },
];
const CONTROL_STATUSES: { value: ControlStatus; label: string }[] = [
  { value: "proposed", label: "Proposed" },
  { value: "planned", label: "Planned" },
  { value: "in_place", label: "In place" },
];
const ORIGIN_LABEL: Record<HazardEntry["origin"], string> = {
  mentioned: "Mentioned by crew",
  task_typical: "Typical for task",
  site_condition: "From site condition",
  human: "Added by reviewer",
};
// eslint-disable-next-line react-refresh/only-export-components
export const CONTROL_TYPE_RANK: Record<ControlType, number> = {
  elimination: 0,
  substitution: 1,
  isolation: 2,
  engineering: 3,
  administrative: 4,
  ppe: 5,
};

// eslint-disable-next-line react-refresh/only-export-components
export function sortHazards(hazards: HazardEntry[]): HazardEntry[] {
  const ruledOut = (h: HazardEntry) => (h.status === "not_present" ? 1 : 0);
  return [...hazards].sort(
    (a, b) =>
      ruledOut(a) - ruledOut(b) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      a.name.localeCompare(b.name),
  );
}

/** Everything about one hazard, for the side panel: status, risk, controls and the evidence behind it. */
export function HazardEditor({ hazard, risk }: { hazard: HazardEntry; risk?: HazardRisk }) {
  const { edit, applyEdit, editing, humanProvenance } = useSessionUi();
  const [adding, setAdding] = useState(false);
  const base = pointer("hazards", hazard.code);
  const controls = Object.values(hazard.controls).sort(
    (a, b) => CONTROL_TYPE_RANK[a.type] - CONTROL_TYPE_RANK[b.type] || a.name.localeCompare(b.name),
  );

  // Status decisions are stamped as human provenance (evidence kept), so the AI cannot flip them back.
  const setStatus = (status: HazardStatus) =>
    applyEdit([
      { op: "replace", path: `${base}/status`, value: status, provenance: humanProvenance() },
      { op: "replace", path: `${base}/provenance`, value: humanProvenance(hazard.provenance), provenance: humanProvenance() },
    ]);

  const setControlStatus = (c: ControlEntry, status: ControlStatus) => {
    const cp = `${base}/controls/${pointer(c.code).slice(1)}`;
    return applyEdit([
      { op: "replace", path: `${cp}/status`, value: status, provenance: humanProvenance() },
      { op: "replace", path: `${cp}/provenance`, value: humanProvenance(c.provenance), provenance: humanProvenance() },
    ]);
  };

  const removeControl = (c: ControlEntry) =>
    applyEdit([{ op: "remove", path: `${base}/controls/${pointer(c.code).slice(1)}`, provenance: humanProvenance() }]);

  const stated = controls.filter((c) => c.status !== "proposed");
  const suggested = controls.filter((c) => c.status === "proposed");
  const controlRow = (c: ControlEntry) => (
    <li key={c.code} className={`control control-${c.status}`} data-path={`${base}/controls/${pointer(c.code).slice(1)}`} tabIndex={-1}>
      <div className="control-main">
        <span className={`ctype ctype-${c.type}`}>{humanize(c.type)}</span>
        <span className="control-name">{c.name}</span>
      </div>
      <div className="control-side">
        <select
          aria-label={`Status of ${c.name}`}
          value={c.status}
          disabled={!edit.allowed || editing}
          onChange={(e) => void setControlStatus(c, e.target.value as ControlStatus)}
        >
          {CONTROL_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <ProvenanceMeta provenance={c.provenance} compact />
        {edit.allowed && (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Remove control ${c.name}`}
            title="Remove control"
            disabled={editing}
            onClick={() => void removeControl(c)}
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );

  const removeHazard = () => applyEdit([{ op: "remove", path: base, provenance: humanProvenance() }]);

  return (
    <div className="hazard-editor" data-path={base}>
      <p className="muted small">
        {humanize(hazard.category)} · {SEVERITY_LABEL_SHORT[hazard.severity]} severity · {ORIGIN_LABEL[hazard.origin]}
      </p>
      {hazard.description && <p className="hazard-desc">{hazard.description}</p>}

      <div className="he-grid">
        <label className="field">
          <span>Status</span>
          <select
            value={hazard.status}
            disabled={!edit.allowed || editing}
            title={edit.allowed ? undefined : edit.reason}
            onChange={(e) => void setStatus(e.target.value as HazardStatus)}
            className={`status-${hazard.status}`}
          >
            {HAZARD_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <div className="he-risk">
          <span className="he-label">Risk before</span>
          <RiskChip risk={risk?.before} />
        </div>
        <div className="he-risk">
          <span className="he-label">Risk after</span>
          <RiskChip risk={risk?.after} />
        </div>
      </div>
      {risk && <p className="muted small">{risk.basis}.</p>}

      <div className="controls" data-path={`${base}/controls`}>
        <h3 className="he-head">Controls</h3>
        {stated.length === 0 ? (
          hazard.status !== "not_present" && <p className="warn-text small">No control stated</p>
        ) : (
          <ul>{stated.map(controlRow)}</ul>
        )}
        {suggested.length > 0 && (
          <details className="suggested">
            <summary>
              {suggested.length} more suggested by the hazard library
            </summary>
            <ul>{suggested.map(controlRow)}</ul>
          </details>
        )}
        {edit.allowed && (
          <div className="hazard-actions">
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setAdding(true)}>
              <Plus size={16} aria-hidden="true" />
              Add control
            </button>
            {hazard.code.includes("-CUSTOM-") && (
              <button type="button" className="btn btn-small btn-danger-ghost" disabled={editing} onClick={() => void removeHazard()}>
                <Trash2 size={16} aria-hidden="true" />
                Remove hazard
              </button>
            )}
          </div>
        )}
      </div>

      <div className="he-evidence">
        <h3 className="he-head">Why it is on the form</h3>
        <EvidenceList provenance={hazard.provenance} />
      </div>
      {adding && <AddControlDialog hazard={hazard} onClose={() => setAdding(false)} />}
    </div>
  );
}

const SEVERITY_LABEL_SHORT: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

function AddControlDialog({ hazard, onClose }: { hazard: HazardEntry; onClose: () => void }) {
  const { applyEdit, editing, humanProvenance } = useSessionUi();
  const library = useLibrary();
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<ControlStatus>("planned");
  const typical = new Set(library.data?.hazards.find((h) => h.code === hazard.code)?.typical_controls ?? []);
  const available = (library.data?.controls ?? [])
    .filter((c) => !hazard.controls[c.code])
    .sort((a, b) => Number(typical.has(b.code)) - Number(typical.has(a.code)) || a.name.localeCompare(b.name));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const def = available.find((c) => c.code === code);
    if (!def) return;
    const value: Omit<ControlEntry, "provenance"> = {
      code: def.code,
      name: def.name,
      type: def.type,
      status,
      description: def.description,
    };
    const ok = await applyEdit([
      { op: "add", path: `${pointer("hazards", hazard.code)}/controls/${pointer(def.code).slice(1)}`, value, provenance: humanProvenance() },
    ]);
    if (ok) onClose();
  };

  return (
    <Modal
      title={`Add control — ${hazard.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="add-control" className="btn btn-primary" disabled={!code || editing}>
            Add control
          </button>
        </>
      }
    >
      <form id="add-control" className="form-grid" onSubmit={(e) => void submit(e)}>
        <label className="field field-wide">
          <span>Control from the library</span>
          <select value={code} onChange={(e) => setCode(e.target.value)} required autoFocus>
            <option value="">Choose a control</option>
            {available.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} · {humanize(c.type)}
                {typical.has(c.code) ? " (typical)" : ""}
              </option>
            ))}
          </select>
          <span className="muted small">Controls marked “typical” are usual for this hazard.</span>
        </label>
        <label className="field">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as ControlStatus)}>
            {CONTROL_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </form>
    </Modal>
  );
}

export function AddHazardDialog({ existing, onClose }: { existing: Record<string, HazardEntry>; onClose: () => void }) {
  const { applyEdit, editing, humanProvenance } = useSessionUi();
  const library = useLibrary();
  const [mode, setMode] = useState<"library" | "custom">("library");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("other");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [description, setDescription] = useState("");

  const available = (library.data?.hazards ?? []).filter((h) => !existing[h.code]);
  const customCode = `HZ-CUSTOM-${slugify(name)}`;
  const customClash = mode === "custom" && !!existing[customCode];
  const valid = mode === "library" ? !!code : !!slugify(name) && !customClash;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let value: Omit<HazardEntry, "provenance">;
    if (mode === "library") {
      const def = available.find((h) => h.code === code);
      if (!def) return;
      value = {
        code: def.code,
        name: def.name,
        category: def.category,
        severity: def.severity,
        status: "present",
        origin: "human",
        description: def.description,
        controls: {},
      };
    } else {
      value = {
        code: customCode,
        name: name.trim(),
        category: category.trim() || "other",
        severity,
        status: "present",
        origin: "human",
        description: description.trim(),
        controls: {},
      };
    }
    const ok = await applyEdit([{ op: "add", path: pointer("hazards", value.code), value, provenance: humanProvenance() }]);
    if (ok) onClose();
  };

  return (
    <Modal
      title="Add hazard"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="add-hazard" className="btn btn-primary" disabled={!valid || editing}>
            Add hazard
          </button>
        </>
      }
    >
      <div className="segmented" role="radiogroup" aria-label="Hazard source">
        <label>
          <input type="radio" name="hz-mode" checked={mode === "library"} onChange={() => setMode("library")} /> From library
        </label>
        <label>
          <input type="radio" name="hz-mode" checked={mode === "custom"} onChange={() => setMode("custom")} /> Custom hazard
        </label>
      </div>
      <form id="add-hazard" className="form-grid" onSubmit={(e) => void submit(e)}>
        {mode === "library" ? (
          <label className="field field-wide">
            <span>Hazard</span>
            <select value={code} onChange={(e) => setCode(e.target.value)} required>
              <option value="">Choose a hazard</option>
              {available.map((h) => (
                <option key={h.code} value={h.code}>
                  {h.name} · {h.severity} ({h.code})
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label className="field field-wide">
              <span>Name *</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
              <span className={`small ${customClash ? "text-danger" : "muted"}`}>
                Code: <span className="mono">{slugify(name) ? customCode : "HZ-CUSTOM-…"}</span>
                {customClash && " — already on the form"}
              </span>
            </label>
            <label className="field">
              <span>Category</span>
              <input value={category} onChange={(e) => setCategory(e.target.value)} />
            </label>
            <label className="field">
              <span>Severity</span>
              <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </label>
            <label className="field field-wide">
              <span>Description</span>
              <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </>
        )}
      </form>
    </Modal>
  );
}
