import { useEffect, useMemo } from "react";
import type { TranscriptSegment } from "../api/types";
import { EmptyState, Skeleton } from "../components/Feedback";
import { formatOffset, formatTime } from "../format";
import { flash, useSessionUi } from "./SessionContext";

/**
 * What the crew said, shown in the side drawer. Evidence links open it on the quoted line. Lines
 * CrewBrief ignored (off-topic, low confidence, its own spoken prompts) stay in the API and audit
 * log but are never shown here.
 */
export function TranscriptPane({ loading }: { loading: boolean }) {
  const { segments, speakerName, highlightedSegmentId } = useSessionUi();
  const visible = useMemo(() => segments.filter((s) => !s.filtered && s.source !== "voice_prompt"), [segments]);

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
  const cls = ["seg", highlighted && "seg-highlight", !seg.is_final && "seg-partial"].filter(Boolean).join(" ");
  return (
    <li id={`seg-${seg.id}`} className={cls} tabIndex={-1}>
      <div className="seg-head">
        <span className="speaker">{speaker}</span>
        <span className="muted small mono" title={`Received ${formatTime(seg.received_at)}`}>
          {formatOffset(seg.start_ms)}
        </span>
        {seg.redacted && <span className="badge badge-outline small">PII redacted</span>}
      </div>
      <p>{seg.text}</p>
    </li>
  );
}
