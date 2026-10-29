import { LIVE_STATES, type Session } from "@/api/types";

/** Where a crew member should land for a session, given its state. */
export function sessionRoute(session: Pick<Session, "id" | "state">): string {
  const base = `/sessions/${encodeURIComponent(session.id)}`;
  if (session.state === "CREATED") return `${base}/prebrief`;
  if (LIVE_STATES.includes(session.state)) return `${base}/live`;
  return `${base}/review`;
}
