import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { User } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { canOpen, devUsersQuery, HOME, isCrew } from "../auth/roles";
import { BrandMark } from "../components/Brand";
import { InlineError, Skeleton } from "../components/Feedback";
import { useToast } from "../components/Toasts";

const POST_LOGIN_KEY = "crewbrief.postLogin";

/** Sign-in only: logo, one line, and the people who can sign in. */
export function LandingPage() {
  const { status, user, mode, error, logout } = useAuth();
  const navigate = useNavigate();

  // Entra: after the sign-in redirect, continue straight to the briefings.
  useEffect(() => {
    if (status !== "authenticated" || !user) return;
    let pending = false;
    try {
      pending = sessionStorage.getItem(POST_LOGIN_KEY) === "1";
      sessionStorage.removeItem(POST_LOGIN_KEY);
    } catch {
      pending = false;
    }
    if (pending) navigate(HOME, { replace: true });
  }, [status, user, navigate]);

  return (
    <main id="main" tabIndex={-1} className="signin">
      <div className="signin-card card">
        <div className="signin-brand">
          <BrandMark size={48} />
          <h1>Sign in to CrewBrief</h1>
          <p className="muted">Talk through the pre-job briefing. CrewBrief fills in the hazard assessment.</p>
        </div>

        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}

        {user ? (
          <div className="signin-current">
            <p>
              Signed in as <strong>{user.name}</strong>
            </p>
            <Link to={HOME} className="btn btn-primary btn-large btn-block">
              Continue to my briefings
            </Link>
            <button type="button" className="btn btn-ghost btn-block" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        ) : mode === "dev" ? (
          <DevSignIn />
        ) : (
          <EntraSignIn />
        )}
      </div>
    </main>
  );
}

function DevSignIn() {
  const { loginAs } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState<string | null>(null);
  const users = useQuery(devUsersQuery);
  const people = (users.data ?? []).filter(isCrew);

  const signIn = async (u: User) => {
    setBusy(u.id);
    try {
      await loginAs(u.id);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && canOpen(u, from) ? from : HOME, { replace: true });
    } catch (err) {
      toast.error(err, "Sign-in failed");
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="signin-title">
      <h2 id="signin-title" className="signin-label">
        Choose your account
      </h2>
      {users.isPending && <Skeleton lines={4} height={44} />}
      {users.isError && <InlineError error={users.error} onRetry={() => void users.refetch()} />}
      <ul className="user-list">
        {people.map((u) => (
          <li key={u.id}>
            <button type="button" className="user-option" disabled={busy !== null} onClick={() => void signIn(u)}>
              <span className="avatar" aria-hidden="true">
                {u.name.charAt(0)}
              </span>
              <span className="user-option-text">
                <strong>{u.name}</strong>
                {u.employee_no && <span className="muted small">{u.employee_no}</span>}
              </span>
              {busy === u.id ? <span className="spinner" aria-label="Signing in" /> : <ChevronRight size={20} aria-hidden="true" className="muted" />}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EntraSignIn() {
  const { loginWithEntra } = useAuth();
  const toast = useToast();
  const signIn = () => {
    try {
      sessionStorage.setItem(POST_LOGIN_KEY, "1");
    } catch {
      // Without storage the user simply lands here again and picks "Go to my briefings".
    }
    loginWithEntra().catch((err: unknown) => toast.error(err, "Sign-in failed"));
  };
  return (
    <button type="button" className="btn btn-primary btn-large btn-block" onClick={signIn}>
      Sign in with Microsoft
    </button>
  );
}
