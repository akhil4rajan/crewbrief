import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { api, errorMessage } from "@/api/client";
import type { Session } from "@/api/types";
import { useCurrentUser } from "@/auth/AuthContext";
import { FormSummary } from "@/components/FormSummary";
import { GapList } from "@/components/GapList";
import { useLoad } from "@/hooks/useLoad";
import { useLibrary } from "@/hooks/useLibrary";
import { useUsers } from "@/hooks/useUsers";
import { Banner, BigButton, Body, Card, Loading, Screen, Title } from "@/ui/primitives";
import { colors, font, space } from "@/ui/theme";

const POLL_MS = 5_000;
const SETTLED = new Set<Session["state"]>(["SUBMITTED", "ABANDONED"]);

export default function ReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const me = useCurrentUser();
  const { data: detail, error: loadError, reload, setData } = useLoad(() => api.session(id), [id]);
  const { nameOf } = useUsers();
  const { taskTypeName } = useLibrary();
  const [acking, setAcking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll until the supervisor has finished with it; cheap and robust on patchy mobile data.
  const state = detail?.session.state;
  useEffect(() => {
    if (!state || SETTLED.has(state)) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [state, reload]);

  if (!detail) return loadError ? <Screen><Banner kind="error" message={loadError} /></Screen> : <Loading />;
  const { session, draft, gaps } = detail;
  const crew = Object.values(draft.form.crew).filter((c) => c.checked_in_at);
  const mine = draft.form.crew[me.id];

  const acknowledge = async () => {
    setAcking(true);
    setError(null);
    try {
      setData(await api.acknowledge(id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAcking(false);
    }
  };

  return (
    <Screen footer={<BigButton label="Back to my jobs" variant="secondary" onPress={() => router.replace("/")} />}>
      <Title>{session.title}</Title>
      <StatusBanner session={session} nameOf={nameOf} />
      {error ? <Banner kind="error" message={error} onDismiss={() => setError(null)} /> : null}

      <Card title="Crew sign-on">
        {crew.map((c) => (
          <View key={c.user_id} style={styles.crewRow}>
            <Text style={styles.crewName}>{c.name}</Text>
            <Text style={[styles.crewState, c.acknowledged && styles.crewAck]}>{c.acknowledged ? "✓ Read and agreed" : "Not yet"}</Text>
          </View>
        ))}
        {mine?.checked_in_at && !mine.acknowledged && !SETTLED.has(session.state) ? (
          <BigButton testID="acknowledge" label="I've read the hazards and controls" onPress={() => void acknowledge()} loading={acking} />
        ) : null}
      </Card>

      <GapList gaps={gaps} title="Open gaps" />
      <FormSummary draft={draft} taskTypeName={taskTypeName} />
    </Screen>
  );
}

function StatusBanner({ session, nameOf }: { session: Session; nameOf: (id: string | null | undefined) => string }) {
  const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");
  switch (session.state) {
    case "BRIEFING":
    case "DRAFTING":
    case "GAP_CHECK":
      return <Banner kind="info" message="Finishing the draft and checking for gaps…" />;
    case "REVIEW":
      return <Banner kind="warning" message="Waiting for the supervisor to review and sign." />;
    case "SIGNED":
      return (
        <View testID="signed" style={styles.signed}>
          <Banner kind="success" message={`Signed by ${nameOf(session.signed_by)} · ${when(session.signed_at)}`} />
          {session.sign_off_comment ? <Body muted>“{session.sign_off_comment}”</Body> : null}
        </View>
      );
    case "SUBMITTED":
      return (
        <Banner
          kind="success"
          message={`Signed by ${nameOf(session.signed_by)} and submitted${session.submission_ref ? ` (ref ${session.submission_ref})` : ""} · ${when(session.submitted_at)}`}
        />
      );
    case "ABANDONED":
      return <Banner kind="error" message={`Abandoned${session.abandon_reason ? `: ${session.abandon_reason}` : ""}`} />;
    case "CREATED":
      return <Banner kind="info" message="This briefing hasn't started yet." />;
  }
}

const styles = StyleSheet.create({
  crewRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.md, minHeight: 40 },
  crewName: { fontSize: font.body, fontWeight: "800", color: colors.text, flexShrink: 1 },
  crewState: { fontSize: font.body, color: colors.textMuted, fontWeight: "700" },
  crewAck: { color: colors.success },
  signed: { gap: space.sm },
});
