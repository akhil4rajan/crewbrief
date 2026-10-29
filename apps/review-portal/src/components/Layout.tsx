import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useHealth } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout, hasRole } = useAuth();
  const health = useHealth();
  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <NavLink to="/sessions" className="brand">
          <span className="brand-mark" aria-hidden="true">
            ✓
          </span>
          CrewBrief <span className="brand-sub">Review</span>
        </NavLink>
        <nav aria-label="Main">
          <NavLink to="/sessions">Briefings</NavLink>
          {hasRole("supervisor", "safety_admin") && <NavLink to="/metrics">Accuracy</NavLink>}
        </nav>
        <div className="topbar-right">
          {health.data?.mode === "local" && (
            <span className="badge badge-outline" title="Services are running with offline stand-ins">
              Local mode
            </span>
          )}
          {health.isError && (
            <span className="badge gap-blocking" title="The form API health check failed">
              API unreachable
            </span>
          )}
          <span className="user-chip">
            <span className="avatar" aria-hidden="true">
              {user?.name.charAt(0)}
            </span>
            <span>
              <span className="user-name">{user?.name}</span>
              <span className="user-roles">{user?.roles.map((r) => r.replace("_", " ")).join(", ")}</span>
            </span>
          </span>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
