import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth/AuthProvider";
import { isCrew } from "./auth/roles";
import { EmptyState, Skeleton } from "./components/Feedback";
import { CrewBriefingPage } from "./crew/CrewBriefingPage";
import { CrewHomePage } from "./crew/CrewHomePage";
import { CrewLayout } from "./crew/CrewLayout";
import { LandingPage } from "./pages/LandingPage";

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
      <Route
        element={
          <RequireCrew>
            <CrewLayout />
          </RequireCrew>
        }
      >
        <Route path="/crew" element={<CrewHomePage />} />
        <Route path="/crew/briefings/:sessionId" element={<CrewBriefingPage />} />
        <Route path="*" element={<Navigate to="/crew" replace />} />
      </Route>
    </Routes>
  );
}

function RequireCrew({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  if (isCrew(user)) return <>{children}</>;
  return (
    <main className="centered">
      <EmptyState title="This account isn't on a crew">
        CrewBrief is used by field crews.{" "}
        <button type="button" className="btn btn-small" onClick={() => void logout()}>
          Sign out
        </button>
      </EmptyState>
    </main>
  );
}
