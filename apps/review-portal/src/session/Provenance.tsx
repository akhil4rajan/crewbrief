import { Pencil, Quote } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useUserDirectory } from "../api/queries";
import type { EvidenceRef, Provenance } from "../api/types";
import { formatDateTime, formatOffset, formatPercent } from "../format";
import { useSessionUi } from "./SessionContext";

function confidenceBand(c: number): "high" | "medium" | "low" {
  if (c >= 0.8) return "high";
  if (c >= 0.5) return "medium";
  return "low";
}

export function ConfidenceMeter({ value }: { value: number }) {
  const band = confidenceBand(value);
  return (
    <span className={`confidence conf-${band}`} title={`AI confidence ${formatPercent(value)} (${band})`}>
      <span className="conf-bar" aria-hidden="true">
        <span style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span className="conf-text">{formatPercent(value)}</span>
      <span className="sr-only"> confidence, {band}</span>
    </span>
  );
}

/** One line naming who or what produced a value: the AI model and its confidence, or the person who edited it. */
export function ProvenanceLine({ provenance }: { provenance: Provenance }) {
  const users = useUserDirectory();
  if (provenance.source === "human") {
    const who = provenance.updated_by ? (users.get(provenance.updated_by)?.name ?? provenance.updated_by) : "a person";
    return (
      <span className="prov-line">
        Set by {who} · {formatDateTime(provenance.updated_at)}
      </span>
    );
  }
  if (provenance.source === "system") return <span className="prov-line">Set by the system</span>;
  return (
    <span className="prov-line">
      AI · {formatPercent(provenance.confidence)} confidence
      {provenance.model && (
        <>
          {" "}
          · <span className="mono">{provenance.model}</span>
        </>
      )}
      {provenance.prompt_version && <> · prompt {provenance.prompt_version}</>}
    </span>
  );
}

/** "n quotes" button that opens the supporting transcript evidence; each quote jumps to its segment. */
export function EvidencePopover({ evidence, provenance }: { evidence: EvidenceRef[]; provenance?: Provenance }) {
  const { speakerName, highlightSegment } = useSessionUi();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const quotes = evidence.filter((e) => e.segment_id);
  if (quotes.length === 0) {
    return (
      <span className="evidence-none" title="No transcript evidence supports this value">
        No evidence
      </span>
    );
  }
  return (
    <span className="evidence" ref={ref}>
      <button
        type="button"
        className="evidence-btn"
        aria-expanded={open}
        aria-controls={popId}
        onClick={() => setOpen((o) => !o)}
      >
        <Quote size={12} aria-hidden="true" /> {quotes.length}
        <span className="sr-only">{quotes.length === 1 ? " quote" : " quotes"}</span>
      </button>
      {open && (
        <div id={popId} className="popover" role="dialog" aria-label="Supporting evidence">
          {provenance && <ProvenanceLine provenance={provenance} />}
          <ul>
            {quotes.map((q, i) => (
              <li key={`${q.segment_id}-${i}`}>
                <button
                  type="button"
                  className="quote"
                  onClick={() => {
                    highlightSegment(q.segment_id);
                    setOpen(false);
                  }}
                >
                  <span className="quote-meta">
                    {speakerName(q.speaker_id)} · {formatOffset(q.start_ms)}
                  </span>
                  <span className="quote-text">“{q.quote || "(no quote captured)"}”</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}

/** Confidence + evidence for AI values, or a "human-edited" marker for values a person set. */
export function ProvenanceMeta({ provenance, compact }: { provenance: Provenance | null | undefined; compact?: boolean }) {
  const users = useUserDirectory();
  if (!provenance) return null;
  if (provenance.source === "human") {
    const who = provenance.updated_by ? (users.get(provenance.updated_by)?.name ?? provenance.updated_by) : "a person";
    return (
      <span className="prov">
        <span className="human-mark" title={`Edited by ${who} · ${formatDateTime(provenance.updated_at)}`}>
          <Pencil size={12} aria-hidden="true" /> {compact ? "Edited" : `Edited by ${who}`}
        </span>
        {provenance.evidence.length > 0 && <EvidencePopover evidence={provenance.evidence} />}
      </span>
    );
  }
  if (provenance.source === "system") {
    return <span className="prov muted small">System</span>;
  }
  return (
    <span className="prov" title={provenance.model ? `${provenance.model} · ${provenance.prompt_version ?? ""}` : undefined}>
      <span className="ai-mark">AI</span>
      <ConfidenceMeter value={provenance.confidence} />
      <EvidencePopover evidence={provenance.evidence} />
    </span>
  );
}

/**
 * Form-document variant: a quiet quote button that holds the evidence, confidence and model behind
 * a click. Values with no transcript evidence show nothing (or a small "Edited" mark for people).
 */
export function QuietProvenance({ provenance }: { provenance: Provenance | null | undefined }) {
  if (!provenance) return null;
  const quotes = provenance.evidence.filter((e) => e.segment_id);
  if (quotes.length > 0) return <EvidencePopover evidence={provenance.evidence} provenance={provenance} />;
  if (provenance.source === "human") {
    return (
      <span className="human-mark" title="Edited by a person">
        <Pencil size={12} aria-hidden="true" /> Edited
      </span>
    );
  }
  return null;
}

/** Evidence written out in full (side panel): who said what, each quote opening the transcript. */
export function EvidenceList({ provenance }: { provenance: Provenance }) {
  const { speakerName, highlightSegment } = useSessionUi();
  const quotes = provenance.evidence.filter((e) => e.segment_id);
  return (
    <div className="evidence-list">
      <ProvenanceLine provenance={provenance} />
      {quotes.length === 0 ? (
        <p className="muted small">No transcript quote supports this.</p>
      ) : (
        <ul>
          {quotes.map((q, i) => (
            <li key={`${q.segment_id}-${i}`}>
              <button type="button" className="quote" onClick={() => highlightSegment(q.segment_id)}>
                <span className="quote-meta">
                  {speakerName(q.speaker_id)} · {formatOffset(q.start_ms)}
                </span>
                <span className="quote-text">“{q.quote || "(no quote captured)"}”</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
