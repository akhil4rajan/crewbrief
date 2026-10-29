import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { User } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { canOpen, devUsersQuery, homeFor, isCrew, isSupervisor, type Area } from "../auth/roles";
import { InlineError, Skeleton } from "../components/Feedback";
import { useToast } from "../components/Toasts";

const POST_LOGIN_KEY = "crewbrief.postLogin";

const STEPS = [
  {
    title: "The crew briefs as normal",
    body: "One phone or tablet listens to the pre-job talk. Crew tap in so the form knows who is on the job.",
  },
  {
    title: "The form fills in live",
    body: "Tasks, site conditions, hazards and controls appear as they are said. Gaps are asked out loud, like “what's the isolation plan?”",
  },
  {
    title: "A supervisor signs off",
    body: "They review a complete draft with the evidence for every field, fix anything, and sign off.",
  },
];

const NUMBERS = [
  { value: "40 → <5", unit: "min", label: "From filling in a form by hand to reviewing a finished draft" },
  { value: "~2", unit: "s", label: "From speech to the field appearing on screen" },
  { value: "≥98", unit: "%", label: "Critical hazard recall on the gold evaluation set" },
];

/** Public front door: what CrewBrief does, and a way in for crew and supervisors. */
export function LandingPage() {
  const { status, user, mode, error, logout } = useAuth();
  const navigate = useNavigate();

  // Entra: after the sign-in redirect, continue straight to the user's area.
  useEffect(() => {
    if (status !== "authenticated" || !user) return;
    let pending = false;
    try {
      pending = sessionStorage.getItem(POST_LOGIN_KEY) === "1";
      sessionStorage.removeItem(POST_LOGIN_KEY);
    } catch {
      pending = false;
    }
    if (pending) navigate(homeFor(user), { replace: true });
  }, [status, user, navigate]);

  return (
    <div className="landing">
      <header className="landing-top">
        <Link to="/" className="brand brand-large">
          <span className="brand-mark" aria-hidden="true">
            ✓
          </span>
          CrewBrief
        </Link>
        {user && (
          <div className="landing-user">
            <span className="muted small">
              Signed in as <strong>{user.name}</strong>
            </span>
            <Link to={homeFor(user)} className="btn btn-primary btn-small">
              {isSupervisor(user) ? "Go to reviews" : "Go to my briefings"} →
            </Link>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        )}
      </header>

      <main id="main" tabIndex={-1}>
        <section className="hero">
          <p className="eyebrow">Voice AI for utility field crews</p>
          <h1>Turn the crew's pre-job briefing into a completed hazard assessment.</h1>
          <p className="hero-sub">
            CrewBrief listens to the briefing the crew already does, drafts the hazard form as they talk, asks about
            anything missing before work starts, and hands the supervisor a draft that is ready to sign.
          </p>
        </section>

        <section className="numbers" aria-label="Key numbers">
          {NUMBERS.map((n) => (
            <div key={n.label} className="number">
              <span className="number-value">
                {n.value}
                <span className="number-unit">{n.unit}</span>
              </span>
              <span className="number-label">{n.label}</span>
            </div>
          ))}
        </section>

        <section className="how" aria-labelledby="how-title">
          <h2 id="how-title">How it works</h2>
          <ol className="steps">
            {STEPS.map((s, i) => (
              <li key={s.title} className="step">
                <span className="step-num" aria-hidden="true">
                  {i + 1}
                </span>
                <div>
                  <h3>{s.title}</h3>
                  <p className="muted">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="entry" aria-labelledby="entry-title">
          <h2 id="entry-title">Try it</h2>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {mode === "dev" ? (
            <div className="entry-grid">
              <EntryCard
                area="crew"
                icon="🦺"
                title="I'm on the crew"
                body="Run a pre-job briefing on your phone or tablet and watch the form fill in."
              />
              <EntryCard
                area="supervisor"
                icon="📋"
                title="I'm a supervisor"
                body="Review drafted hazard assessments with evidence, then sign off."
              />
            </div>
          ) : (
            <EntraEntry />
          )}
        </section>
      </main>
      <footer className="landing-foot muted small">
        Raw audio is never stored. Transcripts are redacted for personal information.
      </footer>
    </div>
  );
}

function EntryCard({ area, icon, title, body }: { area: Area; icon: string; title: string; body: string }) {
  const { loginAs } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState<string | null>(null);
  const users = useQuery(devUsersQuery);
  const people = (users.data ?? []).filter((u) => (area === "crew" ? isCrew(u) : isSupervisor(u)));

  const signIn = async (u: User) => {
    setBusy(u.id);
    try {
      await loginAs(u.id);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && canOpen(u, from) ? from : homeFor(u), { replace: true });
    } catch (err) {
      toast.error(err, "Sign-in failed");
      setBusy(null);
    }
  };

  return (
    <article className={`entry-card entry-${area}`} aria-labelledby={`entry-${area}-title`}>
      <div className="entry-head">
        <span className="entry-icon" aria-hidden="true">
          {icon}
        </span>
        <div>
          <h3 id={`entry-${area}-title`}>{title}</h3>
          <p className="muted small">{body}</p>
        </div>
      </div>
      <p className="entry-pick">Continue as</p>
      {users.isPending && <Skeleton lines={3} height={44} />}
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
                <span className="muted small">{u.roles.map((r) => r.replace("_", " ")).join(", ")}</span>
              </span>
              {busy === u.id ? <span className="spinner" aria-label="Signing in" /> : <span aria-hidden="true">→</span>}
            </button>
          </li>
        ))}
      </ul>
    </article>
  );
}

function EntraEntry() {
  const { loginWithEntra } = useAuth();
  const toast = useToast();
  const signIn = () => {
    try {
      sessionStorage.setItem(POST_LOGIN_KEY, "1");
    } catch {
      // Without storage the user simply lands here again and picks "Go to…".
    }
    loginWithEntra().catch((err: unknown) => toast.error(err, "Sign-in failed"));
  };
  return (
    <div className="entry-card entry-single">
      <p className="muted">Sign in with your organisation account. Crew go to their briefings, supervisors to reviews.</p>
      <button type="button" className="btn btn-primary btn-large" onClick={signIn}>
        Sign in with Microsoft
      </button>
    </div>
  );
}
