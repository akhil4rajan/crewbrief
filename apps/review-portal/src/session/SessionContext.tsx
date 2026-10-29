import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { api } from "../api/endpoints";
import { applyPatches } from "../api/jsonPointer";
import { qk, useUserDirectory } from "../api/queries";
import type { FormPatch, Provenance, SessionDetail, TranscriptSegment, User } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useToast } from "../components/Toasts";
import { editPermission, type Permission } from "./permissions";

interface SessionUi {
  detail: SessionDetail;
  segments: TranscriptSegment[];
  edit: Permission;
  /** Send human edits; resolves true when every patch was applied. */
  applyEdit: (patches: FormPatch[]) => Promise<boolean>;
  editing: boolean;
  humanProvenance: (base?: Provenance) => Provenance;
  speakerName: (speakerId: string | null | undefined) => string;
  highlightedSegmentId: string | null;
  highlightSegment: (segmentId: string) => void;
  focusPath: (path: string) => void;
}

const Ctx = createContext<SessionUi | null>(null);

function primaryRole(user: User | null): string {
  if (!user) return "unknown";
  return user.roles.find((r) => r === "supervisor" || r === "safety_admin") ?? user.roles[0] ?? "crew";
}

/** Briefly flash an element so the eye can find what was scrolled to. */
function flash(el: Element) {
  el.classList.remove("flash");
  void (el as HTMLElement).offsetWidth; // restart the animation
  el.classList.add("flash");
  window.setTimeout(() => el.classList.remove("flash"), 1800);
}

export function SessionProvider({
  detail,
  segments,
  children,
}: {
  detail: SessionDetail;
  segments: TranscriptSegment[];
  children: ReactNode;
}) {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const users = useUserDirectory();
  const [highlightedSegmentId, setHighlighted] = useState<string | null>(null);
  const sessionId = detail.session.id;
  const edit = useMemo(() => editPermission(user, detail.session), [user, detail.session]);

  const mutation = useMutation({
    mutationFn: (patches: FormPatch[]) => {
      const current = qc.getQueryData<SessionDetail>(qk.session(sessionId)) ?? detail;
      return api.patchDraft(sessionId, { patches, expected_revision: current.draft.revision });
    },
  });

  const applyEdit = useCallback(
    async (patches: FormPatch[]): Promise<boolean> => {
      try {
        const result = await mutation.mutateAsync(patches);
        const current = qc.getQueryData<SessionDetail>(qk.session(sessionId));
        if (current && result.revision > current.draft.revision) {
          try {
            const form = applyPatches(current.draft.form, result.applied);
            qc.setQueryData<SessionDetail>(qk.session(sessionId), {
              ...current,
              draft: { ...current.draft, form, revision: result.revision },
            });
          } catch {
            void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
          }
        }
        if (result.rejected.length) {
          toast.push(
            "warning",
            `${result.rejected.length} change${result.rejected.length > 1 ? "s were" : " was"} rejected`,
            result.rejected.map((r) => r.reason).join(" · "),
          );
          return false;
        }
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          toast.push("warning", "The draft changed while you were editing", "Reloaded the latest version — please check and re-apply your change.");
          await qc.invalidateQueries({ queryKey: qk.session(sessionId) });
        } else {
          toast.error(err, "Could not save the change");
        }
        return false;
      }
    },
    [mutation, qc, sessionId, toast],
  );

  const humanProvenance = useCallback(
    (base?: Provenance): Provenance => ({
      source: "human",
      role: primaryRole(user),
      model: null,
      prompt_version: null,
      evidence: base?.evidence ?? [],
      confidence: 1,
      updated_by: user?.id ?? null,
      updated_at: new Date().toISOString(),
    }),
    [user],
  );

  const speakerName = useCallback(
    (speakerId: string | null | undefined) => {
      if (!speakerId) return "Unknown speaker";
      const user = users.get(speakerId);
      if (user) return user.name;
      const seg = segments.find((s) => s.speaker_id === speakerId || s.user_id === speakerId);
      return seg?.speaker_name ?? (seg?.user_id ? users.get(seg.user_id)?.name : undefined) ?? speakerId;
    },
    [users, segments],
  );

  const highlightSegment = useCallback((segmentId: string) => {
    setHighlighted(segmentId);
    const el = document.getElementById(`seg-${segmentId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      flash(el);
    }
  }, []);

  const focusPath = useCallback((path: string) => {
    const parts = path.split("/");
    // Walk up the pointer until something on screen represents it (e.g. a gap on a hazard control).
    while (parts.length > 1) {
      const candidate = parts.join("/");
      const el = document.querySelector<HTMLElement>(`[data-path="${CSS.escape(candidate)}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus({ preventScroll: true });
        flash(el);
        return;
      }
      parts.pop();
    }
  }, []);

  const value = useMemo<SessionUi>(
    () => ({
      detail,
      segments,
      edit,
      applyEdit,
      editing: mutation.isPending,
      humanProvenance,
      speakerName,
      highlightedSegmentId,
      highlightSegment,
      focusPath,
    }),
    [detail, segments, edit, applyEdit, mutation.isPending, humanProvenance, speakerName, highlightedSegmentId, highlightSegment, focusPath],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSessionUi(): SessionUi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSessionUi must be used inside <SessionProvider>");
  return ctx;
}
