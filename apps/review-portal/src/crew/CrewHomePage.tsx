import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/endpoints";
import { qk, useLibrary, useLibraryIndex } from "../api/queries";
import type { CreateSessionRequest } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { EmptyState, InlineError, Skeleton, StateBadge } from "../components/Feedback";
import { useToast } from "../components/Toasts";
import { formatRelative } from "../format";
import { rememberScenario, SCENARIOS, type Scenario } from "./scenarios";

const REFRESH_MS = 15_000;

export function CrewHomePage() {
  const { user } = useAuth();
  const firstName = user?.name.split(" ")[0] ?? "";
  return (
    <div className="crew-page">
      <header className="crew-hero">
        <h1>G'day{firstName ? `, ${firstName}` : ""}</h1>
        <p className="muted">Start the pre-job briefing here. CrewBrief drafts the hazard assessment while you talk.</p>
      </header>
      <div className="crew-home-grid">
        <NewBriefing />
        <MyBriefings />
      </div>
    </div>
  );
}

function MyBriefings() {
  const sessions = useQuery({ queryKey: qk.mySessions, queryFn: () => api.sessions({ mine: true }), refetchInterval: REFRESH_MS });
  const { taskTypeName } = useLibraryIndex();
  return (
    <section className="card crew-card" aria-labelledby="mine-title">
      <h2 id="mine-title">My briefings</h2>
      {sessions.isPending && <Skeleton lines={4} height={48} />}
      {sessions.isError && <InlineError error={sessions.error} onRetry={() => void sessions.refetch()} />}
      {sessions.data?.length === 0 && (
        <EmptyState title="No briefings yet">Start one with the form, or pick a demo scenario.</EmptyState>
      )}
      <ul className="briefing-list">
        {sessions.data?.map((s) => (
          <li key={s.id}>
            <Link to={`/crew/briefings/${s.id}`} className="briefing-item">
              <span className="briefing-item-main">
                <strong>{s.title}</strong>
                <span className="muted small">
                  {taskTypeName(s.task_type)} · {s.location ?? "No location"}
                </span>
              </span>
              <span className="briefing-item-side">
                <StateBadge state={s.state} />
                <span className="muted small">{formatRelative(s.updated_at)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NewBriefing() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const library = useLibrary();
  const crew = useQuery({ queryKey: ["users", "crew"], queryFn: () => api.users("crew") });
  const supervisors = useQuery({ queryKey: ["users", "supervisor"], queryFn: () => api.users("supervisor") });
  const [supervisorId, setSupervisorId] = useState("");
  const chosenSupervisor = supervisorId || supervisors.data?.[0]?.id || "";

  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [title, setTitle] = useState("");
  const [taskType, setTaskType] = useState("");
  const [location, setLocation] = useState("");
  const [crewIds, setCrewIds] = useState<string[]>(() => (user ? [user.id] : []));

  const applyScenario = (s: Scenario) => {
    setScenario(s);
    setTitle(s.title);
    setTaskType(s.task_type);
    setLocation(s.location);
    setCrewIds(user && !s.crew.includes(user.id) ? [user.id, ...s.crew] : s.crew);
  };

  const create = useMutation({
    mutationFn: (body: CreateSessionRequest) => api.createSession(body),
    onSuccess: (detail) => {
      rememberScenario(detail.session.id, scenario?.id ?? null);
      void queryClient.invalidateQueries({ queryKey: qk.sessions });
      queryClient.setQueryData(qk.session(detail.session.id), detail);
      navigate(`/crew/briefings/${detail.session.id}`);
    },
    onError: (err) => toast.error(err, "Could not start the briefing"),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({
      title: title.trim(),
      task_type: taskType || null,
      location: location.trim() || null,
      crew_member_ids: crewIds,
      supervisor_id: chosenSupervisor || null,
    });
  };

  const toggleCrew = (id: string) =>
    setCrewIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  return (
    <section className="card crew-card" aria-labelledby="new-title">
      <h2 id="new-title">Start a new briefing</h2>

      <div className="scenario-picker">
        <p className="field-label-lg">Use a demo scenario</p>
        <div className="scenario-grid">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="scenario"
              aria-pressed={scenario?.id === s.id}
              onClick={() => applyScenario(s)}
            >
              <strong>{s.title}</strong>
              <span className="muted small">{s.summary}</span>
            </button>
          ))}
        </div>
      </div>

      <form className="crew-form" onSubmit={submit}>
        <label className="field">
          <span>Job title *</span>
          <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. LV service connection, 14 Banksia St" />
        </label>
        <label className="field">
          <span>Task type</span>
          <select value={taskType} onChange={(e) => setTaskType(e.target.value)} disabled={library.isPending}>
            <option value="">— Not specified —</option>
            {library.data?.task_types.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Location</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Address or asset id" />
        </label>
        <label className="field">
          <span>Supervisor to sign off</span>
          <select value={chosenSupervisor} onChange={(e) => setSupervisorId(e.target.value)} disabled={supervisors.isPending}>
            {supervisors.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="field">
          <legend>Crew on this job</legend>
          {crew.isPending && <Skeleton lines={2} />}
          <div className="crew-chips">
            {crew.data?.map((u) => (
              <label key={u.id} className="crew-chip">
                <input type="checkbox" checked={crewIds.includes(u.id)} onChange={() => toggleCrew(u.id)} />
                <span className="avatar" aria-hidden="true">
                  {u.name.charAt(0)}
                </span>
                {u.name}
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" className="btn btn-primary btn-large btn-block" disabled={!title.trim() || create.isPending}>
          {create.isPending ? "Creating…" : "Start briefing →"}
        </button>
      </form>
    </section>
  );
}
