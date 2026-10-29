import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TranscriptSegment } from "../api/types";
import { EmptyState, Skeleton } from "../components/Feedback";
import { formatOffset, formatTime, humanize } from "../format";
import type { ReceivedPrompt } from "../realtime/useSessionLive";
import { useSessionUi } from "./SessionContext";

type Item =
  | { kind: "segment"; key: string; at: string; seg: TranscriptSegment }
  | { kind: "prompt"; key: string; at: string; prompt: ReceivedPrompt };

const NEAR_BOTTOM_PX = 80;

export function TranscriptPane({ loading, prompts }: { loading: boolean; prompts: ReceivedPrompt[] }) {
  const { segments, speakerName, highlightedSegmentId } = useSessionUi();
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const [showFiltered, setShowFiltered] = useState(true);

  // Live voice prompts are shown inline unless the store already holds them as voice_prompt segments.
  const items = useMemo<Item[]>(() => {
    const promptTexts = new Set(segments.filter((s) => s.source === "voice_prompt").map((s) => s.text.trim()));
    const segItems: Item[] = segments
      .filter((s) => showFiltered || !s.filtered)
      .map((seg) => ({ kind: "segment", key: seg.id, at: seg.received_at, seg }));
    const promptItems: Item[] = prompts
      .filter((p) => !promptTexts.has(p.text.trim()))
      .map((prompt) => ({ kind: "prompt", key: prompt.id, at: prompt.ts, prompt }));
    if (promptItems.length === 0) return segItems;
    return [...segItems, ...promptItems].sort((a, b) => a.at.localeCompare(b.at));
  }, [segments, prompts, showFiltered]);

  const filteredCount = segments.filter((s) => s.filtered).length;

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (stick.current) {
      el.scrollTop = el.scrollHeight;
      setUnseen(0);
    } else {
      setUnseen((n) => n + 1);
    }
  }, [items.length]);

  useEffect(() => {
    if (highlightedSegmentId) stick.current = false;
  }, [highlightedSegmentId]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (stick.current) setUnseen(0);
  };

  const jumpToLatest = () => {
    const el = listRef.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setUnseen(0);
  };

  return (
    <section className="pane transcript-pane" aria-labelledby="transcript-title">
      <header className="pane-head">
        <h2 id="transcript-title">
          Transcript <span className="count">{segments.length}</span>
        </h2>
        {filteredCount > 0 && (
          <label className="check small">
            <input type="checkbox" checked={showFiltered} onChange={(e) => setShowFiltered(e.target.checked)} />
            Show filtered ({filteredCount})
          </label>
        )}
      </header>
      {loading && segments.length === 0 ? (
        <Skeleton lines={6} />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing said yet">Speech appears here live as the crew briefs.</EmptyState>
      ) : (
        <ol className="transcript" ref={listRef} onScroll={onScroll} aria-live="polite" aria-relevant="additions">
          {items.map((item) =>
            item.kind === "prompt" ? (
              <li key={item.key} className="seg seg-prompt">
                <div className="seg-head">
                  <span className="speaker">
                    <span aria-hidden="true">🔊</span> CrewBrief asked
                  </span>
                  <span className="muted small">{formatTime(item.at)}</span>
                </div>
                <p>{item.prompt.text}</p>
              </li>
            ) : (
              <SegmentRow
                key={item.key}
                seg={item.seg}
                speaker={item.seg.speaker_name ?? speakerName(item.seg.user_id ?? item.seg.speaker_id)}
                highlighted={item.seg.id === highlightedSegmentId}
              />
            ),
          )}
        </ol>
      )}
      {unseen > 0 && (
        <button type="button" className="btn btn-small jump-latest" onClick={jumpToLatest}>
          ↓ {unseen} new
        </button>
      )}
    </section>
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
              <span aria-hidden="true">🔊</span> CrewBrief asked
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
