import { Pencil } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import type { FieldValue } from "../api/types";
import { QuietProvenance } from "./Provenance";
import { useSessionUi } from "./SessionContext";

export interface Option {
  value: string;
  label: string;
}

interface Props {
  label: string;
  path: string;
  field: FieldValue | null;
  multiline?: boolean;
  options?: Option[];
  /** Render the stored value (e.g. code → name). */
  display?: (value: unknown) => string;
  /** Label above the value (form header cells) instead of beside it. */
  stacked?: boolean;
  /** Extra content after the value, e.g. a decision flag. */
  children?: ReactNode;
}

function asText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** A scalar form field with provenance and inline editing (PATCH replace of the FieldValue). */
export function FieldRow({ label, path, field, multiline, options, display, stacked, children }: Props) {
  const { edit, applyEdit, editing, humanProvenance } = useSessionUi();
  const [draft, setDraft] = useState<string | null>(null);
  const text = asText(field?.value);
  const shown = field && text !== "" ? (display ? display(field.value) : text) : null;

  const save = async () => {
    if (draft === null) return;
    const next = draft.trim();
    if (next === text) return setDraft(null);
    // Clearing stores an explicit human null, so the AI will not silently refill the field.
    const ok = await applyEdit([
      { op: "replace", path, value: { value: next === "" ? null : next }, provenance: humanProvenance() },
    ]);
    if (ok) setDraft(null);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setDraft(null);
    if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  };

  const inputId = `f-${path.replace(/\W/g, "-")}`;
  return (
    <div className={`field-row${stacked ? " field-row-stacked" : ""}`} data-path={path} tabIndex={-1}>
      <label className="field-label" htmlFor={draft !== null ? inputId : undefined}>
        {label}
      </label>
      {draft === null ? (
        <div className="field-value">
          <span className={shown ? "" : "placeholder"}>{shown ?? "Not captured"}</span>
          <span className="field-meta">
            {field && (text !== "" || field.provenance.source === "human") && <QuietProvenance provenance={field.provenance} />}
            {edit.allowed && (
              <button
                type="button"
                className="icon-btn edit-btn"
                aria-label={`Edit ${label}`}
                title={`Edit ${label}`}
                onClick={() => setDraft(text)}
              >
                <Pencil size={16} aria-hidden="true" />
              </button>
            )}
          </span>
        </div>
      ) : (
        <div className="field-edit">
          {options ? (
            <select id={inputId} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} autoFocus>
              <option value="">None</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : multiline ? (
            <textarea id={inputId} rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} autoFocus />
          ) : (
            <input id={inputId} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} autoFocus />
          )}
          <div className="field-edit-actions">
            <button type="button" className="btn btn-primary btn-small" disabled={editing} onClick={() => void save()}>
              Save
            </button>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
