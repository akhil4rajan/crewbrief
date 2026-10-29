/**
 * Client-side mirror of the server's permission rules (packages/rules/engine.py `can_sign_off`,
 * the transition table in packages/schemas/session.py and the role table in docs/api/contracts.md).
 * The server stays authoritative; this only decides what to enable and how to explain it.
 */
import type { Session, SessionState, User, UserRole } from "../api/types";

export interface Permission {
  allowed: boolean;
  reason: string;
}

const ok = (reason = ""): Permission => ({ allowed: true, reason });
const no = (reason: string): Permission => ({ allowed: false, reason });

const LIVE: SessionState[] = ["BRIEFING", "DRAFTING", "GAP_CHECK"];
const PRE_REVIEW: SessionState[] = ["CREATED", ...LIVE];
const TERMINAL: SessionState[] = ["SUBMITTED", "ABANDONED"];

function has(user: User | null, ...roles: UserRole[]): boolean {
  return !!user && roles.some((r) => user.roles.includes(r));
}

export function isSupervisorLike(user: User | null): boolean {
  return has(user, "supervisor", "safety_admin");
}

export function editPermission(user: User | null, s: Session): Permission {
  if (TERMINAL.includes(s.state) || s.state === "SIGNED") return no(`The form is locked once ${s.state.toLowerCase()}`);
  if (has(user, "supervisor")) return ok();
  if (has(user, "crew")) {
    return PRE_REVIEW.includes(s.state) ? ok() : no("Crew can edit only until the briefing goes to review");
  }
  return no("Your role cannot edit the form");
}

export function signOffPermission(user: User | null, s: Session): Permission {
  if (s.state !== "REVIEW") return no(`Sign-off is available in review (now ${s.state.toLowerCase().replace("_", " ")})`);
  if (has(user, "safety_admin")) return ok();
  if (!has(user, "supervisor")) return no("Only a supervisor can sign off");
  if (s.supervisor_id && s.supervisor_id !== user?.id) return no("Only the session's assigned supervisor can sign off");
  if (user && s.crew_member_ids.includes(user.id)) return no("A crew member on the job cannot sign off their own form");
  return ok();
}

export interface ActionPermissions {
  endBriefing: Permission;
  resumeBriefing: Permission;
  signOff: Permission;
  submit: Permission;
  abandon: Permission;
  dismissGap: Permission;
  viewAudit: Permission;
}

export function actionPermissions(user: User | null, s: Session): ActionPermissions {
  const crewOrSup = has(user, "crew", "supervisor");
  return {
    endBriefing: !LIVE.includes(s.state)
      ? no(s.state === "CREATED" ? "The briefing has not started yet" : "The briefing has already ended")
      : crewOrSup
        ? ok()
        : no("Only crew or a supervisor can end the briefing"),
    resumeBriefing:
      s.state !== "REVIEW"
        ? no("A briefing can be resumed only from review")
        : has(user, "supervisor")
          ? ok()
          : no("Only a supervisor can send a briefing back to the crew"),
    signOff: signOffPermission(user, s),
    submit:
      s.state !== "SIGNED"
        ? no(s.state === "SUBMITTED" ? "Already submitted" : "Sign off before submitting")
        : has(user, "supervisor")
          ? ok()
          : no("Only a supervisor can submit"),
    abandon:
      TERMINAL.includes(s.state) || s.state === "SIGNED"
        ? no(s.state === "SIGNED" ? "A signed form can only be submitted" : "The session is closed")
        : crewOrSup
          ? ok()
          : no("Only crew or a supervisor can abandon a session"),
    dismissGap: has(user, "supervisor") ? (TERMINAL.includes(s.state) ? no("The session is closed") : ok()) : no("Only a supervisor can dismiss gaps"),
    viewAudit: isSupervisorLike(user) ? ok() : no("Audit and diff are visible to supervisors and safety admins"),
  };
}
