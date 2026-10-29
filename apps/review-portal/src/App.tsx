import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth/AuthProvider";
import { fitsArea, homeFor, type Area } from "./auth/roles";
import { Skeleton } from "./components/Feedback";
import { Layout } from "./components/Layout";
import { CrewBriefingPage } from "./crew/CrewBriefingPage";
import { CrewHomePage } from "./crew/CrewHomePage";
import { CrewLayout } from "./crew/CrewLayout";
import { LandingPage } from "./pages/LandingPage";
import { MetricsPage } from "./pages/MetricsPage";
import { SessionPage } from "./pages/SessionPage";
import { SessionsPage } from "./pages/SessionsPage";

export function App() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <main className="centered">
        <Skeleton lines={3} />
      </main>
    );
  }
  if (status === "anonymous") {
    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="*" element={<Navigate to="/" replace state={{ from: location.pathname }} />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route
        element={
          <RequireArea area="crew">
            <CrewLayout />
          </RequireArea>
        }
      >
        <Route path="/crew" element={<CrewHomePage />} />
        <Route path="/crew/briefings/:sessionId" element={<CrewBriefingPage />} />
        <Route path="/crew/*" element={<Navigate to="/crew" replace />} />
      </Route>
      <Route
        element={
          <RequireArea area="supervisor">
            <Layout />
          </RequireArea>
        }
      >
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/:sessionId" element={<SessionPage />} />
        <Route path="/metrics" element={<MetricsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

/** Role guard: crew use /crew, supervisors and safety admins use /sessions and /metrics. */
function RequireArea({ area, children }: { area: Area; children: ReactNode }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  if (fitsArea(user, area)) return <>{children}</>;
  // Same briefing, other side: /sessions/:id ⇄ /crew/briefings/:id.
  const crewMatch = pathname.match(/^\/crew\/briefings\/([^/]+)/);
  const supMatch = pathname.match(/^\/sessions\/([^/]+)/);
  if (area === "supervisor" && supMatch && fitsArea(user, "crew")) {
    return <Navigate to={`/crew/briefings/${supMatch[1]}`} replace />;
  }
  if (area === "crew" && crewMatch && fitsArea(user, "supervisor")) {
    return <Navigate to={`/sessions/${crewMatch[1]}`} replace />;
  }
  return <Navigate to={homeFor(user)} replace />;
}

function NotFound() {
  return (
    <div className="page">
      <h1>Page not found</h1>
      <p className="muted">The page you asked for does not exist.</p>
    </div>
  );
}
