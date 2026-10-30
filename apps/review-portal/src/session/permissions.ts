/**
 * Client-side mirror of the server's permission rules (packages/rules/engine.py `can_sign_off`,
 * the transition table in packages/schemas/session.py and docs/api/contracts.md). One app, one
 * role: the crew lead (whoever created the briefing) reviews, signs off and submits; the rest of
 * the crew read the form and acknowledge it. The server stays authoritative; this only decides
 * what to enable and how to explain it.
 */
import type { Session, SessionState, User } from "../api/types";

export interface Permission {
  allowed: boolean;
  reason: string;
}

const ok = (reason = ""): Permission => ({ allowed: true, reason });
const no = (reason: string): Permission => ({ allowed: false, reason });

const LIVE: SessionState[] = ["BRIEFING", "DRAFTING", "GAP_CHECK"];
const PRE_REVIEW: SessionState[] = ["CREATED", ...LIVE];
const TERMINAL: SessionState[] = ["SUBMITTED", "ABANDONED"];
const LEAD_ONLY = "Only the crew lead who started this briefing can do this";

export function isLead(user: User | null, s: Session): boolean {
  return !!user && s.created_by === user.id;
}

function onJob(user: User | null, s: Session): boolean {
  return !!user && (isLead(user, s) || s.crew_member_ids.includes(user.id));
}

export function editPermission(user: User | null, s: Session): Permission {
  if (TERMINAL.includes(s.state) || s.state === "SIGNED") return no(`The form is locked once ${s.state.toLowerCase()}`);
  if (isLead(user, s)) return ok();
  if (onJob(user, s) && PRE_REVIEW.includes(s.state)) return ok();
  return no(LEAD_ONLY);
}

export interface ActionPermissions {
  resumeBriefing: Permission;
  signOff: Permission;
  submit: Permission;
  abandon: Permission;
  dismissGap: Permission;
}

export function actionPermissions(user: User | null, s: Session): ActionPermissions {
  const lead = isLead(user, s);
  return {
    resumeBriefing: s.state !== "REVIEW" ? no("A briefing can be resumed only from review") : lead ? ok() : no(LEAD_ONLY),
    signOff: s.state !== "REVIEW" ? no(`Sign-off is available in review (now ${s.state.toLowerCase().replace("_", " ")})`) : lead ? ok() : no(LEAD_ONLY),
    submit: s.state !== "SIGNED" ? no(s.state === "SUBMITTED" ? "Already submitted" : "Sign off before submitting") : lead ? ok() : no(LEAD_ONLY),
    abandon:
      TERMINAL.includes(s.state) || s.state === "SIGNED"
        ? no(s.state === "SIGNED" ? "A signed form can only be submitted" : "The briefing is closed")
        : lead
          ? ok()
          : no(LEAD_ONLY),
    dismissGap: TERMINAL.includes(s.state) || s.state === "SIGNED" ? no("The form is locked") : lead ? ok() : no(LEAD_ONLY),
  };
}
