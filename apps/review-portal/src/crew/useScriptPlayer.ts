import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { ScenarioLine } from "./scenarios";

export type PlayerStatus = "idle" | "playing" | "paused" | "done";

export interface ScriptPlayer {
  status: PlayerStatus;
  /** Index of the next line to send. */
  next: number;
  current: ScenarioLine | null;
  play(): void;
  pause(): void;
  restart(): void;
}

const HOLD_RETRY_MS = 300;
const RESUME_DELAY_MS = 600;

/**
 * Plays a scripted briefing: each line is handed to `onLine` at its scripted time divided by
 * `speed`. While `holdRef` is true (a voice prompt is being spoken, or recording is paused) the
 * script waits, so the crew's scripted answers never talk over CrewBrief.
 */
export function useScriptPlayer(
  lines: ScenarioLine[],
  speed: number,
  onLine: (line: ScenarioLine) => void,
  holdRef: MutableRefObject<boolean>,
): ScriptPlayer {
  const [status, setStatus] = useState<PlayerStatus>("idle");
  const [next, setNext] = useState(0);
  const [current, setCurrent] = useState<ScenarioLine | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const nextRef = useRef(0);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const onLineRef = useRef(onLine);
  onLineRef.current = onLine;
  const linesRef = useRef(lines);

  const clear = () => window.clearTimeout(timer.current);

  const fire = useCallback(
    (i: number) => {
      const all = linesRef.current;
      if (holdRef.current) {
        timer.current = window.setTimeout(() => fire(i), HOLD_RETRY_MS);
        return;
      }
      const line = all[i];
      if (!line) {
        setStatus("done");
        return;
      }
      onLineRef.current(line);
      setCurrent(line);
      nextRef.current = i + 1;
      setNext(i + 1);
      const following = all[i + 1];
      if (!following) {
        setStatus("done");
        return;
      }
      const delay = Math.max(250, (following.at_ms - line.at_ms) / speedRef.current);
      timer.current = window.setTimeout(() => fire(i + 1), delay);
    },
    [holdRef],
  );

  // A different script resets the player.
  useEffect(() => {
    linesRef.current = lines;
    clear();
    nextRef.current = 0;
    setNext(0);
    setCurrent(null);
    setStatus("idle");
  }, [lines]);

  useEffect(() => clear, []);

  const play = useCallback(() => {
    clear();
    if (nextRef.current >= linesRef.current.length) return;
    setStatus("playing");
    const delay = nextRef.current === 0 ? 0 : RESUME_DELAY_MS;
    const i = nextRef.current;
    timer.current = window.setTimeout(() => fire(i), delay);
  }, [fire]);

  const pause = useCallback(() => {
    clear();
    setStatus((s) => (s === "playing" ? "paused" : s));
  }, []);

  const restart = useCallback(() => {
    clear();
    nextRef.current = 0;
    setNext(0);
    setCurrent(null);
    setStatus("idle");
  }, []);

  return { status, next, current, play, pause, restart };
}
