import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/endpoints";
import type { User } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { InlineError, Skeleton } from "../components/Feedback";
import { useToast } from "../components/Toasts";

export function LoginPage() {
  const { mode, error } = useAuth();
  return (
    <main className="login">
      <div className="login-card">
        <div className="brand brand-large">
          <span className="brand-mark" aria-hidden="true">
            ✓
          </span>
          CrewBrief
        </div>
        <p className="muted">Review and sign off pre-job hazard assessments drafted from crew briefings.</p>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {mode === "dev" ? <DevLogin /> : <EntraLogin />}
      </div>
    </main>
  );
}

function DevLogin() {
  const { loginAs } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState<string | null>(null);
  const users = useQuery({ queryKey: ["dev-users"], queryFn: api.devUsers });

  const signIn = async (u: User) => {
    setBusy(u.id);
    try {
      await loginAs(u.id);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== "/login" ? from : "/sessions", { replace: true });
    } catch (err) {
      toast.error(err, "Sign-in failed");
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="dev-login-title">
      <h1 id="dev-login-title" className="h2">
        Development sign-in
      </h1>
      <p className="muted small">Choose a seeded user. Tokens are kept for this browser tab only.</p>
      {users.isPending && <Skeleton lines={4} height={40} />}
      {users.isError && <InlineError error={users.error} onRetry={() => void users.refetch()} />}
      <ul className="user-list">
        {users.data?.map((u) => (
          <li key={u.id}>
            <button type="button" className="user-option" disabled={busy !== null} onClick={() => void signIn(u)}>
              <span className="avatar" aria-hidden="true">
                {u.name.charAt(0)}
              </span>
              <span className="user-option-text">
                <strong>{u.name}</strong>
                <span className="muted small">
                  {u.roles.map((r) => r.replace("_", " ")).join(", ")} · {u.id}
                </span>
              </span>
              {busy === u.id && <span className="spinner" aria-label="Signing in" />}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EntraLogin() {
  const { loginWithEntra } = useAuth();
  const toast = useToast();
  return (
    <section>
      <h1 className="h2">Sign in</h1>
      <p className="muted small">Use your organisation account.</p>
      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={() => loginWithEntra().catch((err: unknown) => toast.error(err, "Sign-in failed"))}
      >
        Sign in with Microsoft
      </button>
    </section>
  );
}
