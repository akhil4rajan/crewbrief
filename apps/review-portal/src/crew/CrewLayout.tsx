import { Link, Outlet, useLocation } from "react-router-dom";
import { useHealth } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
import { ErrorBoundary } from "../components/ErrorBoundary";

/** App shell: brand, who is signed in, sign out. Phone-first, large touch targets. */
export function CrewLayout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const health = useHealth();

  return (
    <div className="app crew-app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar crew-topbar">
        <Link to="/crew" className="brand" title="My briefings">
          <span className="brand-mark" aria-hidden="true">
            ✓
          </span>
          CrewBrief
        </Link>
        <div className="topbar-right">
          {health.data?.mode === "local" && (
            <span className="badge badge-outline hide-narrow" title="Services are running with offline stand-ins">
              Local mode
            </span>
          )}
          <span className="user-chip">
            <span className="avatar" aria-hidden="true">
              {user?.name.charAt(0)}
            </span>
            <span className="user-name hide-narrow">{user?.name}</span>
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
