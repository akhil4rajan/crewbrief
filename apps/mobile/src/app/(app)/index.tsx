import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { api } from "@/api/client";
import type { Session } from "@/api/types";
import { useCurrentUser } from "@/auth/AuthContext";
import { useLoad } from "@/hooks/useLoad";
import { sessionRoute } from "@/navigation";
import { Banner, BigButton, Body, Loading, Pill, Screen, Title } from "@/ui/primitives";
import { colors, font, radius, space, stateLabel, touch } from "@/ui/theme";

export default function JobsScreen() {
  const user = useCurrentUser();
  const { data, error, loading, reload } = useLoad(() => api.mySessions(), []);

  // Come back to an up-to-date list after a briefing (the first focus is the initial load).
  const focusedBefore = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedBefore.current) void reload();
      focusedBefore.current = true;
    }, [reload]),
  );

  const sessions = data ?? [];
  const active = sessions.filter((s) => s.state !== "SUBMITTED" && s.state !== "ABANDONED");
  const done = sessions.filter((s) => s.state === "SUBMITTED" || s.state === "ABANDONED");

  return (
    <Screen
      footer={<BigButton testID="new-briefing" label="＋ Start a new briefing" onPress={() => router.push("/new")} />}
    >
      <Title>G&apos;day, {user.name.split(" ")[0]}</Title>
      {error ? <Banner kind="error" message={error} /> : null}
      {loading && !data ? <Loading /> : null}
      {data && sessions.length === 0 ? <Body muted>No briefings yet. Start one when the crew is together.</Body> : null}
      {active.length > 0 ? <Section title="Today" sessions={active} /> : null}
      {done.length > 0 ? <Section title="Finished" sessions={done} /> : null}
      {data ? <BigButton label="Refresh" variant="ghost" onPress={() => void reload()} loading={loading} /> : null}
    </Screen>
  );
}

function Section({ title, sessions }: { title: string; sessions: Session[] }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {sessions.map((s) => (
        <SessionRow key={s.id} session={s} />
      ))}
    </View>
  );
}

function SessionRow({ session }: { session: Session }) {
  const live = ["BRIEFING", "DRAFTING", "GAP_CHECK"].includes(session.state);
  return (
    <Pressable
      testID={`session-${session.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${session.title}, ${stateLabel[session.state]}`}
      onPress={() => router.push(sessionRoute(session))}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.8 }]}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{session.title}</Text>
        <Text style={styles.rowMeta}>
          {[session.location, new Date(session.created_at).toLocaleString()].filter(Boolean).join(" · ")}
        </Text>
      </View>
      <Pill
        label={stateLabel[session.state]}
        fg={live ? "#FFFFFF" : colors.text}
        bg={live ? colors.recording : colors.surface}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  sectionTitle: { fontSize: font.body, fontWeight: "800", color: colors.textMuted, textTransform: "uppercase" },
  row: {
    minHeight: touch.primary,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: font.large, fontWeight: "800", color: colors.text },
  rowMeta: { fontSize: font.small, color: colors.textMuted },
});
