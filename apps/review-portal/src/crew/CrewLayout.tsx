import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useMatch } from "react-router-dom";
import { qk, useHealth } from "../api/queries";
import type { SessionDetail } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { isSupervisor, useSwitchArea } from "../auth/roles";
import { ErrorBoundary } from "../components/ErrorBoundary";

/** Crew shell: no supervisor navigation, large touch targets, phone-first. */
export function CrewLayout() {
  const { user, mode, logout } = useAuth();
  const location = useLocation();
  const health = useHealth();
  const switchArea = useSwitchArea();
  const queryClient = useQueryClient();
  const briefing = useMatch("/crew/briefings/:sessionId");
  const sessionId = briefing?.params.sessionId;

  const openSupervisorView = () => {
    const detail = sessionId ? queryClient.getQueryData<SessionDetail>(qk.session(sessionId)) : undefined;
    void switchArea("supervisor", sessionId ? `/sessions/${sessionId}` : "/sessions", [detail?.session.supervisor_id]);
  };

  return (
    <div className="app crew-app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar crew-topbar">
        <Link to="/" className="brand" title="CrewBrief home">
          <span className="brand-mark" aria-hidden="true">
            ✓
          </span>
          CrewBrief <span className="brand-sub">Crew</span>
        </Link>
        <div className="topbar-right">
          {health.data?.mode === "local" && (
            <span className="badge badge-outline hide-narrow" title="Services are running with offline stand-ins">
              Local mode
            </span>
          )}
          {(mode === "dev" || isSupervisor(user)) && (
            <button type="button" className="btn btn-ghost btn-small" onClick={openSupervisorView}>
              Supervisor view ↗
            </button>
          )}
          <span className="user-chip">
            <span className="avatar" aria-hidden="true">
              {user?.name.charAt(0)}
            </span>
            <span className="hide-narrow">
              <span className="user-name">{user?.name}</span>
              <span className="user-roles">Crew</span>
            </span>
          </span>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="crew-main">
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
