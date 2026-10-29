import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useHealth } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
import { ErrorBoundary } from "./ErrorBoundary";

/** Supervisor / safety admin shell: top bar with navigation, then the routed page. */
export function Layout() {
  const { user, logout, hasRole } = useAuth();
  const location = useLocation();
  const health = useHealth();
  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/" className="brand" title="CrewBrief home">
          <span className="brand-mark" aria-hidden="true">
            ✓
          </span>
          CrewBrief <span className="brand-sub">Review</span>
        </Link>
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
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
