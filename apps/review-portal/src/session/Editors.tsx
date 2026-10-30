import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { api } from "../api/endpoints";
import { qk, useLibraryIndex } from "../api/queries";
import type { Gap } from "../api/types";
import { Drawer } from "../components/Drawer";
import { InlineError, Skeleton } from "../components/Feedback";
import { DismissDialog } from "./Decisions";
import { FieldRow } from "./FieldRow";
import { HazardEditor } from "./Hazards";
import { useSessionUi } from "./SessionContext";
import { SpeakerRow } from "./Speakers";

/** Form sections that have a side-panel editor (hazards have their own, per hazard). */
export type SectionKey = "job" | "emergency" | "notes" | "crew";

const SECTION_TITLE: Record<SectionKey, string> = {
  job: "Job details",
  emergency: "Emergency plan",
  notes: "Notes",
  crew: "Crew sign-on",
};

/** The section editor that holds a form path, if any. */
// eslint-disable-next-line react-refresh/only-export-components
export function sectionFor(path: string): SectionKey | null {
  const top = path.split("/")[1];
  return top === "job" || top === "emergency" || top === "notes" || top === "crew" ? top : null;
}

interface Editors {
  openHazard: (code: string) => void;
  openSection: (key: SectionKey) => void;
  requestDismiss: (gap: Gap) => void;
  /** A panel or dialog is open (the Check step waits for it to close before moving on). */
  busy: boolean;
}

const Ctx = createContext<Editors | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useEditors(): Editors {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useEditors outside <EditorsProvider>");
  return ctx;
}

/** Side panels shared by the Check and Sign views: hazard editor, section editors, dismiss dialog. */
export function EditorsProvider({ children }: { children: ReactNode }) {
  const { detail } = useSessionUi();
  const [hazardCode, setHazardCode] = useState<string | null>(null);
  const [section, setSection] = useState<SectionKey | null>(null);
  const [dismissing, setDismissing] = useState<Gap | null>(null);
  const hazard = hazardCode ? detail.draft.form.hazards[hazardCode] : undefined;
  const busy = !!hazard || !!section || !!dismissing;

  const value = useMemo<Editors>(
    () => ({ openHazard: setHazardCode, openSection: setSection, requestDismiss: setDismissing, busy }),
    [busy],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {hazard && (
        <Drawer title={hazard.name} onClose={() => setHazardCode(null)}>
          <HazardEditor hazard={hazard} risk={detail.risk?.[hazard.code]} />
        </Drawer>
      )}
      {section && (
        <Drawer title={SECTION_TITLE[section]} onClose={() => setSection(null)}>
          <SectionEditor section={section} />
        </Drawer>
      )}
      {dismissing && <DismissDialog gap={dismissing} sessionId={detail.session.id} onClose={() => setDismissing(null)} />}
    </Ctx.Provider>
  );
}

function SectionEditor({ section }: { section: SectionKey }) {
  const { detail } = useSessionUi();
  const { library, taskTypeName } = useLibraryIndex();
  const form = detail.draft.form;
  if (section === "job") {
    const job = form.job;
    const taskOptions = (library?.task_types ?? []).map((t) => ({ value: t.code, label: t.name }));
    return (
      <div className="section-editor">
        <FieldRow label="Work order" path="/job/work_order_id" field={job.work_order_id} />
        <FieldRow label="Location / asset" path="/job/location" field={job.location} />
        <FieldRow
          label="Task type"
          path="/job/task_type"
          field={job.task_type}
          options={taskOptions}
          display={(v) => taskTypeName(String(v))}
        />
        <FieldRow label="Scope of work" path="/job/description" field={job.description} multiline />
      </div>
    );
  }
  if (section === "emergency") {
    const e = form.emergency;
    return (
      <div className="section-editor">
        <FieldRow label="Muster point" path="/emergency/muster_point" field={e.muster_point} />
        <FieldRow label="Nearest hospital" path="/emergency/nearest_hospital" field={e.nearest_hospital} />
        <FieldRow label="First aider" path="/emergency/first_aider" field={e.first_aider} />
        <FieldRow label="Communications" path="/emergency/communications" field={e.communications} />
      </div>
    );
  }
  if (section === "notes") {
    return (
      <div className="section-editor">
        <FieldRow label="Notes" path="/notes" field={form.notes} multiline />
      </div>
    );
  }
  return <VoicesEditor />;
}

/** Name each separated voice; naming one signs that person on to the crew. */
function VoicesEditor() {
  const { detail, edit } = useSessionUi();
  const speakers = useQuery({ queryKey: qk.speakers(detail.session.id), queryFn: () => api.speakers(detail.session.id) });
  return (
    <div className="section-editor">
      <p className="muted small">Name each voice in the recording to add that person to the crew sign-on.</p>
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
    </div>
  );
}
