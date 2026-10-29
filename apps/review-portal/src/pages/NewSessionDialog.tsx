import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/endpoints";
import { qk, useLibrary, useUsers } from "../api/queries";
import type { CreateSessionRequest } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Skeleton } from "../components/Feedback";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const { user, hasRole } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const library = useLibrary();
  const users = useUsers();
  const crew = useQuery({ queryKey: ["users", "crew"], queryFn: () => api.users("crew") });

  const [title, setTitle] = useState("");
  const [workOrder, setWorkOrder] = useState("");
  const [taskType, setTaskType] = useState("");
  const [location, setLocation] = useState("");
  const [crewIds, setCrewIds] = useState<string[]>(() => (hasRole("crew") && user ? [user.id] : []));
  const [supervisorId, setSupervisorId] = useState(() => (hasRole("supervisor") && user ? user.id : ""));

  const supervisors = (users.data ?? []).filter((u) => u.roles.includes("supervisor"));

  const create = useMutation({
    mutationFn: (body: CreateSessionRequest) => api.createSession(body),
    onSuccess: (detail) => {
      void queryClient.invalidateQueries({ queryKey: qk.sessions });
      queryClient.setQueryData(qk.session(detail.session.id), detail);
      toast.push("success", "Session created", detail.session.title);
      navigate(`/sessions/${detail.session.id}`);
    },
    onError: (err) => toast.error(err, "Could not create the session"),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({
      title: title.trim(),
      work_order_id: workOrder.trim() || null,
      task_type: taskType || null,
      location: location.trim() || null,
      supervisor_id: supervisorId || null,
      crew_member_ids: crewIds,
    });
  };

  const toggleCrew = (id: string) =>
    setCrewIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  return (
    <Modal
      title="New briefing session"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="new-session" className="btn btn-primary" disabled={!title.trim() || create.isPending}>
            {create.isPending ? "Creating…" : "Create session"}
          </button>
        </>
      }
    >
      <form id="new-session" className="form-grid" onSubmit={submit}>
        <label className="field">
          <span>Title *</span>
          <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>Work order</span>
          <input value={workOrder} onChange={(e) => setWorkOrder(e.target.value)} placeholder="WO-12345" />
        </label>
        <label className="field">
          <span>Task type</span>
          <select value={taskType} onChange={(e) => setTaskType(e.target.value)} disabled={library.isPending}>
            <option value="">— Not specified —</option>
            {library.data?.task_types.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name} ({t.code})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Location</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Address or asset id" />
        </label>
        <label className="field">
          <span>Supervisor</span>
          <select value={supervisorId} onChange={(e) => setSupervisorId(e.target.value)}>
            <option value="">— Unassigned —</option>
            {supervisors.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="field field-wide">
          <legend>Crew</legend>
          {crew.isPending && <Skeleton lines={2} />}
          <div className="check-grid">
            {crew.data?.map((u) => (
              <label key={u.id} className="check">
                <input type="checkbox" checked={crewIds.includes(u.id)} onChange={() => toggleCrew(u.id)} />
                {u.name}
              </label>
            ))}
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
