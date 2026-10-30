import { ChevronDown, LogOut } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useHealth } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
import { Wordmark } from "../components/Brand";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { Menu } from "../components/Menu";

/** App shell: a slim top bar with the wordmark and the user menu. */
export function CrewLayout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const health = useHealth();
  const local = health.data?.mode === "local";

  return (
    <div className="app crew-app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/crew" className="brand" aria-label="CrewBrief, my briefings">
            <Wordmark />
          </Link>
          <Menu
            triggerClassName="user-trigger"
            triggerLabel={`Account: ${user?.name ?? ""}`}
            trigger={
              <>
                <span className="avatar" aria-hidden="true">
                  {user?.name.charAt(0)}
                </span>
                <span className="user-name hide-narrow">{user?.name}</span>
                <ChevronDown size={16} aria-hidden="true" className="muted" />
              </>
            }
            header={
              <>
                <strong>{user?.name}</strong>
                {user?.employee_no && <span className="muted">{user.employee_no}</span>}
                {local && (
                  <span className="menu-note" title="Services are running with offline stand-ins">
                    <span className="dot dot-amber" aria-hidden="true" />
                    Local mode
                  </span>
                )}
              </>
            }
            items={[{ label: "Sign out", icon: LogOut, onSelect: () => void logout() }]}
          />
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
