import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api/endpoints";
import { qk, useUsers } from "../api/queries";
import type { SpeakerInfo } from "../api/types";
import { useToast } from "../components/Toasts";

const OTHER = "__other__";

/** One separated voice and who it belongs to (the crew lead can rename it). */
export function SpeakerRow({ sessionId, speaker, canEdit }: { sessionId: string; speaker: SpeakerInfo; canEdit: boolean }) {
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
