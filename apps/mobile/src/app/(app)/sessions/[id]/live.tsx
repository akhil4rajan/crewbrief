import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { LIVE_STATES } from "@/api/types";
import { useCurrentUser } from "@/auth/AuthContext";
import { FormSummary } from "@/components/FormSummary";
import { GapList } from "@/components/GapList";
import { ConnectivityPill, PromptCard, RecordButton, SpeakerPicker, TypeInstead } from "@/components/LiveControls";
import { TranscriptTail } from "@/components/TranscriptTail";
import { useLibrary } from "@/hooks/useLibrary";
import { useUsers } from "@/hooks/useUsers";
import { useLiveBriefing } from "@/live/useLiveBriefing";
import { sessionRoute } from "@/navigation";
import { Banner, BigButton, Card, Loading, Row, Screen, Title } from "@/ui/primitives";
import { space } from "@/ui/theme";

export default function LiveBriefingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const me = useCurrentUser();
  const { nameOf } = useUsers("crew");
  const { taskTypeName } = useLibrary();
  const [speaker, setSpeaker] = useState(me.id);
  const { state, togglePause, sendTyped, dismissPrompt, endBriefing } = useLiveBriefing(id, speaker);
  const { session, draft } = state;
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);

  const reviewHref = `/sessions/${encodeURIComponent(id)}/review`;

  // Another device (or the supervisor) ended or abandoned the briefing.
  useEffect(() => {
    if (session && !LIVE_STATES.includes(session.state)) router.replace(sessionRoute(session));
  }, [session]);

  if (!session || !draft) return state.error ? <Screen><Banner kind="error" message={state.error} /></Screen> : <Loading label="Joining briefing…" />;

  const checkedIn = Object.values(draft.form.crew).filter((c) => c.checked_in_at);
  const speakers = checkedIn.length > 0 ? checkedIn : [{ user_id: me.id, name: me.name, role: "crew", acknowledged: false }];
  const textMode = state.mode === "text";
  const prompt = state.prompts[0];

  const end = async () => {
    if (await endBriefing()) router.replace(reviewHref);
  };

  return (
    <Screen
      footer={
        confirmEnd ? (
          <>
            <Banner kind="warning" message="End the briefing and send the form for review?" />
            <Row style={styles.confirmRow}>
              <BigButton label="Keep going" variant="secondary" onPress={() => setConfirmEnd(false)} style={styles.flex} />
              <BigButton testID="end-confirm" label="End briefing" variant="danger" onPress={() => void end()} loading={state.ending} style={styles.flex} />
            </Row>
          </>
        ) : (
          <BigButton testID="end-briefing" label="End briefing" variant="danger" onPress={() => setConfirmEnd(true)} />
        )
      }
    >
      <View style={styles.header}>
        <Title>{session.title}</Title>
        <ConnectivityPill info={state.connection} />
      </View>
      {state.error ? <Banner kind="error" message={state.error} /> : null}
      {state.notice && state.notice !== dismissedNotice ? (
        <Banner kind="info" message={state.notice} onDismiss={() => setDismissedNotice(state.notice)} />
      ) : null}

      <RecordButton
        paused={state.paused}
        inputMethod={state.inputMethod}
        level={state.level}
        speaking={state.speaking}
        onPress={() => void togglePause()}
      />

      {prompt ? <PromptCard prompt={prompt} onDismiss={() => dismissPrompt(prompt.gap_id)} /> : null}

      {textMode ? (
        <Card>
          <SpeakerPicker crew={speakers} selected={speaker} onSelect={setSpeaker} />
          <TypeInstead onSend={sendTyped} />
        </Card>
      ) : null}

      <TranscriptTail segments={state.transcript} interim={state.interim} nameOf={nameOf} />
      <GapList gaps={state.gaps} />
      <FormSummary draft={draft} taskTypeName={taskTypeName} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.sm },
  confirmRow: { flexWrap: "nowrap" },
  flex: { flex: 1 },
});
