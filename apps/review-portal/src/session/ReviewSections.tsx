import { Check, Plus } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api/endpoints";
import { pointer } from "../api/jsonPointer";
import { qk, useLibraryIndex, useUsers } from "../api/queries";
import type { Form, SpeakerInfo } from "../api/types";
import { EmptyState, InlineError, Skeleton } from "../components/Feedback";
import { useToast } from "../components/Toasts";
import { humanize } from "../format";
import { FieldRow } from "./FieldRow";
import { AddHazardDialog, HazardCard, sortHazards } from "./Hazards";
import { ProvenanceMeta } from "./Provenance";
import { useSessionUi } from "./SessionContext";

function ReviewSection({ id, title, path, count, action, children }: {
  id: string;
  title: string;
  path: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="review-section" aria-labelledby={id} data-path={path} tabIndex={-1}>
      <header className="review-section-head">
        <h2 id={id}>
          {title}
          {count !== undefined && <span className="count">{count}</span>}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function SubHead({ children }: { children: ReactNode }) {
  return <h3 className="sub-head">{children}</h3>;
}

/** Hazards sorted by severity; each card separates what the crew said from library suggestions. */
export function HazardsSection() {
  const { detail, edit } = useSessionUi();
  const [adding, setAdding] = useState(false);
  const hazards = sortHazards(Object.values(detail.draft.form.hazards));
  return (
    <ReviewSection
      id="sec-hazards"
      title="Hazards & controls"
      path="/hazards"
      count={hazards.length}
      action={
        edit.allowed && (
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setAdding(true)}>
            <Plus size={16} aria-hidden="true" />
            Add hazard
          </button>
        )
      }
    >
      {hazards.length === 0 ? (
        <EmptyState title="No hazards recorded">Add one if the crew discussed a hazard CrewBrief missed.</EmptyState>
      ) : (
        <div className="hazard-list">
          {hazards.map((h) => (
            <HazardCard key={h.code} hazard={h} />
          ))}
        </div>
      )}
      {adding && <AddHazardDialog existing={detail.draft.form.hazards} onClose={() => setAdding(false)} />}
    </ReviewSection>
  );
}

export function JobSection() {
  const { detail } = useSessionUi();
  const form: Form = detail.draft.form;
  const { library, taskTypeName } = useLibraryIndex();
  const taskOptions = (library?.task_types ?? []).map((t) => ({ value: t.code, label: t.name }));
  const tasks = Object.values(form.tasks).sort((a, b) => a.order - b.order);
  const conditions = Object.values(form.site_conditions);
  const ppe = Object.values(form.ppe);
  const permits = Object.values(form.permits);

  return (
    <ReviewSection id="sec-job" title="Job & emergency" path="/job">
      <div className="field-grid">
        <FieldRow label="Title" path="/job/title" field={form.job.title} />
        <FieldRow label="Work order" path="/job/work_order_id" field={form.job.work_order_id} />
        <FieldRow label="Task type" path="/job/task_type" field={form.job.task_type} options={taskOptions} display={(v) => taskTypeName(String(v))} />
        <FieldRow label="Location" path="/job/location" field={form.job.location} />
        <FieldRow label="Description" path="/job/description" field={form.job.description} multiline />
      </div>

      <SubHead>Emergency plan</SubHead>
      <div className="field-grid" data-path="/emergency" tabIndex={-1}>
        <FieldRow label="Muster point" path="/emergency/muster_point" field={form.emergency.muster_point} />
        <FieldRow label="Nearest hospital" path="/emergency/nearest_hospital" field={form.emergency.nearest_hospital} />
        <FieldRow label="First aider" path="/emergency/first_aider" field={form.emergency.first_aider} />
        <FieldRow label="Communications" path="/emergency/communications" field={form.emergency.communications} />
      </div>

      {tasks.length > 0 && (
        <>
          <SubHead>Steps</SubHead>
          <ol className="item-list" data-path="/tasks" tabIndex={-1}>
            {tasks.map((t) => (
              <li key={t.id} data-path={pointer("tasks", t.id)} tabIndex={-1}>
                <span>{t.description}</span>
                <ProvenanceMeta provenance={t.provenance} compact />
              </li>
            ))}
          </ol>
        </>
      )}
      {conditions.length > 0 && (
        <>
          <SubHead>Site conditions</SubHead>
          <ul className="item-list" data-path="/site_conditions" tabIndex={-1}>
            {conditions.map((c) => (
              <li key={c.id} data-path={pointer("site_conditions", c.id)} tabIndex={-1}>
                <span>{c.description}</span>
                <ProvenanceMeta provenance={c.provenance} compact />
              </li>
            ))}
          </ul>
        </>
      )}
      {ppe.length > 0 && (
        <>
          <SubHead>PPE</SubHead>
          <ul className="chip-list" data-path="/ppe" tabIndex={-1}>
            {ppe.map((p) => (
              <li key={p.code} className="chip" data-path={pointer("ppe", p.code)} tabIndex={-1}>
                <span>{p.name}</span>
                <ProvenanceMeta provenance={p.provenance} compact />
              </li>
            ))}
          </ul>
        </>
      )}
      {permits.length > 0 && (
        <>
          <SubHead>Permits</SubHead>
          <ul className="item-list" data-path="/permits" tabIndex={-1}>
            {permits.map((p) => (
              <li key={p.id} data-path={pointer("permits", p.id)} tabIndex={-1}>
                <span>
                  {humanize(p.type)} {p.reference && <span className="mono">{p.reference}</span>}
                </span>
                <ProvenanceMeta provenance={p.provenance} compact />
              </li>
            ))}
          </ul>
        </>
      )}
      <SubHead>Notes</SubHead>
      <FieldRow label="Notes" path="/notes" field={form.notes} multiline />
    </ReviewSection>
  );
}

/** Who was on the job, who has read the form, and which voice belongs to whom. */
export function CrewSection() {
  const { detail, edit } = useSessionUi();
  const crew = Object.values(detail.draft.form.crew);
  const speakers = useQuery({ queryKey: qk.speakers(detail.session.id), queryFn: () => api.speakers(detail.session.id) });

  return (
    <ReviewSection id="sec-crew" title="Crew & speakers" path="/crew" count={crew.length}>
      {crew.length === 0 ? (
        <p className="muted small">No one is on the form yet. Name a voice below to add them.</p>
      ) : (
        <ul className="crew-rows">
          {crew.map((c) => (
            <li key={c.user_id} data-path={pointer("crew", c.user_id)} tabIndex={-1}>
              <span className="avatar" aria-hidden="true">
                {c.name.charAt(0)}
              </span>
              <span className="crew-row-name">
                {c.name}
                <span className="muted small"> · {humanize(c.role || "crew")}</span>
              </span>
              <span className={c.acknowledged ? "ok-text small inline-icon" : "muted small"}>
                {c.acknowledged && <Check size={14} aria-hidden="true" />}
                {c.acknowledged ? "Read the form" : "Not read yet"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <SubHead>Voices in the recording</SubHead>
      {speakers.isPending && <Skeleton lines={2} height={32} />}
      {speakers.isError && <InlineError error={speakers.error} onRetry={() => void speakers.refetch()} />}
      {speakers.data?.length === 0 && <p className="muted small">No voices were separated in this briefing.</p>}
      {speakers.data && speakers.data.length > 0 && (
        <ul className="speaker-rows">
          {speakers.data.map((sp) => (
            <SpeakerRow key={sp.speaker_id} sessionId={detail.session.id} speaker={sp} canEdit={edit.allowed} />
          ))}
        </ul>
      )}
    </ReviewSection>
  );
}

const OTHER = "__other__";

function SpeakerRow({ sessionId, speaker, canEdit }: { sessionId: string; speaker: SpeakerInfo; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const users = useUsers();
  const crewUsers = (users.data ?? []).filter((u) => u.roles.includes("crew"));
  const [choice, setChoice] = useState(speaker.user_id ?? (speaker.name ? OTHER : ""));
  const [name, setName] = useState(speaker.user_id ? "" : (speaker.name ?? ""));
  const current = speaker.name ?? (speaker.user_id ? (crewUsers.find((u) => u.id === speaker.user_id)?.name ?? speaker.user_id) : null);

  const save = useMutation({
    mutationFn: () =>
      api.updateSpeaker(sessionId, speaker.speaker_id, choice === OTHER ? { name: name.trim() } : { user_id: choice }),
    onSuccess: () => {
      toast.push("success", `${speaker.label} is now ${choice === OTHER ? name.trim() : (crewUsers.find((u) => u.id === choice)?.name ?? "named")}`);
      void qc.invalidateQueries({ queryKey: qk.speakers(sessionId) });
      void qc.invalidateQueries({ queryKey: qk.transcript(sessionId) });
      void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
    },
    onError: (err) => toast.error(err, "Could not rename the speaker"),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (choice && (choice !== OTHER || name.trim())) save.mutate();
  };
  const selectId = `spk-${speaker.speaker_id}`;
  const unchanged = choice === (speaker.user_id ?? (speaker.name ? OTHER : "")) && (choice !== OTHER || name.trim() === (speaker.name ?? ""));

  return (
    <li className="speaker-row">
      <span className="speaker-row-label">
        <strong>{/^Speaker \d+$/.test(speaker.label) ? speaker.label : (current ?? speaker.label)}</strong>
        <span className="muted small">
          {speaker.segment_count} line{speaker.segment_count === 1 ? "" : "s"}
          {current ? ` · ${current}` : ""}
        </span>
      </span>
      {canEdit ? (
        <form className="speaker-row-form" onSubmit={submit}>
          <label className="sr-only" htmlFor={selectId}>
            Who is {speaker.label}?
          </label>
          <select id={selectId} value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">Who is this?</option>
            {crewUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
            <option value={OTHER}>Someone else…</option>
          </select>
          {choice === OTHER && (
            <>
              <label className="sr-only" htmlFor={`${selectId}-name`}>
                Name
              </label>
              <input id={`${selectId}-name`} value={name} maxLength={100} placeholder="Name" onChange={(e) => setName(e.target.value)} />
            </>
          )}
          <button type="submit" className="btn btn-secondary btn-small" disabled={!choice || (choice === OTHER && !name.trim()) || unchanged || save.isPending}>
            Save
          </button>
        </form>
      ) : (
        <span className="muted small">{current ?? "Unnamed"}</span>
      )}
    </li>
  );
}
