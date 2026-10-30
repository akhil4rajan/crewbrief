import { Volume2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { TranscriptSegment } from "../api/types";
import { EmptyState, Skeleton } from "../components/Feedback";
import { formatOffset, formatTime, humanize } from "../format";
import { flash, useSessionUi } from "./SessionContext";

/** The full transcript, shown in the side drawer. Evidence links open it on the quoted line. */
export function TranscriptPane({ loading }: { loading: boolean }) {
  const { segments, speakerName, highlightedSegmentId } = useSessionUi();
  const [showFiltered, setShowFiltered] = useState(true);
  const visible = useMemo(() => segments.filter((s) => showFiltered || !s.filtered), [segments, showFiltered]);
  const filteredCount = segments.filter((s) => s.filtered).length;

  // Bring the highlighted line into view once it is on screen.
  useEffect(() => {
    if (!highlightedSegmentId) return;
    // Wait a frame: the drawer opens (showModal) after this child effect runs.
    const raf = window.requestAnimationFrame(() => {
      const el = document.getElementById(`seg-${highlightedSegmentId}`);
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      el.focus({ preventScroll: true });
      flash(el);
    });
    return () => window.cancelAnimationFrame(raf);
  }, [highlightedSegmentId, visible.length]);

  return (
    <div className="transcript-pane">
      {filteredCount > 0 && (
        <label className="check small">
          <input type="checkbox" checked={showFiltered} onChange={(e) => setShowFiltered(e.target.checked)} />
          Show lines CrewBrief ignored ({filteredCount})
        </label>
      )}
      {loading && segments.length === 0 ? (
        <Skeleton lines={6} />
      ) : visible.length === 0 ? (
        <EmptyState title="Nothing said yet">Speech appears here as the crew briefs.</EmptyState>
      ) : (
        <ol className="transcript">
          {visible.map((seg) => (
            <SegmentRow
              key={seg.id}
              seg={seg}
              speaker={seg.speaker_name ?? speakerName(seg.user_id ?? seg.speaker_id)}
              highlighted={seg.id === highlightedSegmentId}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function SegmentRow({ seg, speaker, highlighted }: { seg: TranscriptSegment; speaker: string; highlighted: boolean }) {
  const isPrompt = seg.source === "voice_prompt";
  const cls = ["seg", isPrompt && "seg-prompt", seg.filtered && "seg-filtered", highlighted && "seg-highlight", !seg.is_final && "seg-partial"]
    .filter(Boolean)
    .join(" ");
  return (
    <li id={`seg-${seg.id}`} className={cls} tabIndex={-1}>
      <div className="seg-head">
        <span className="speaker">
          {isPrompt ? (
            <>
              <Volume2 size={14} aria-hidden="true" /> CrewBrief asked
            </>
          ) : (
            speaker
          )}
        </span>
        <span className="muted small mono" title={`Received ${formatTime(seg.received_at)}`}>
          {formatOffset(seg.start_ms)}
        </span>
        {seg.confidence < 0.7 && !isPrompt && (
          <span className="badge badge-outline small" title="Speech recognition confidence">
            {Math.round(seg.confidence * 100)}% STT
          </span>
        )}
        {seg.redacted && <span className="badge badge-outline small">PII redacted</span>}
      </div>
      <p>{seg.text}</p>
      {seg.filtered && (
        <p className="filter-reason small">Filtered: {humanize(seg.filter_reason ?? "excluded from extraction")}</p>
      )}
    </li>
  );
}
