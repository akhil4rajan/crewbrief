import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useState } from "react";

import { api, errorMessage } from "@/api/client";
import { useLoad } from "@/hooks/useLoad";
import { useUsers } from "@/hooks/useUsers";
import { ConsentNotice, CrewTapIn, type TapInMember } from "@/components/PreBrief";
import { sessionRoute } from "@/navigation";
import { Banner, BigButton, Body, Loading, Screen, Title } from "@/ui/primitives";

export default function PreBriefScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: detail, error: loadError, setData } = useLoad(() => api.session(id), [id]);
  const { nameOf } = useUsers("crew");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!detail) return loadError ? <Screen><Banner kind="error" message={loadError} /></Screen> : <Loading />;
  const { session, draft } = detail;
  if (session.state !== "CREATED") return <Redirect href={sessionRoute(session)} />;

  const memberIds = [...new Set([...session.crew_member_ids, ...Object.keys(draft.form.crew)])];
  const members: TapInMember[] = memberIds.map((uid) => ({
    userId: uid,
    name: draft.form.crew[uid]?.name || nameOf(uid),
    checkedIn: !!draft.form.crew[uid]?.checked_in_at,
  }));
  const anyCheckedIn = members.some((m) => m.checkedIn);
  const consented = !!session.consent_acknowledged_at;

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const checkIn = (userId: string) =>
    act(userId, async () => {
      setData(await api.checkIn(id, userId));
    });
  const consent = () =>
    act("consent", async () => {
      const updated = await api.consent(id);
      setData((prev) => ({ ...prev!, session: updated }));
    });
  const start = () =>
    act("start", async () => {
      await api.start(id);
      router.replace(`/sessions/${encodeURIComponent(id)}/live`);
    });

  const blocker = !anyCheckedIn ? "At least one person needs to tap in." : !consented ? "Confirm the recording notice first." : null;

  return (
    <Screen
      footer={
        <>
          {blocker ? <Body muted>{blocker}</Body> : null}
          <BigButton testID="start-briefing" label="Start briefing" onPress={() => void start()} disabled={!!blocker || busy !== null} loading={busy === "start"} />
        </>
      }
    >
      <Title>{session.title}</Title>
      {session.location ? <Body muted>{session.location}</Body> : null}
      {error ? <Banner kind="error" message={error} onDismiss={() => setError(null)} /> : null}
      <CrewTapIn members={members} busyId={busy && busy !== "consent" && busy !== "start" ? busy : null} onTap={(uid) => void checkIn(uid)} />
      <ConsentNotice acknowledged={consented} busy={busy === "consent"} onAcknowledge={() => void consent()} />
    </Screen>
  );
}
