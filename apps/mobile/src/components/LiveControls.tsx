import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { CrewEntry, VoicePrompt } from "@/api/types";
import type { InputMethod } from "@/live/useLiveBriefing";
import type { ConnectionInfo } from "@/realtime/DeviceSocket";
import { BigButton, Card, Chip, Pill, Row } from "@/ui/primitives";
import { colors, font, radius, space, touch } from "@/ui/theme";

// --- record / pause ----------------------------------------------------------------------

interface RecordButtonProps {
  paused: boolean;
  inputMethod: InputMethod;
  level: number;
  speaking: boolean;
  onPress: () => void;
}

/** The one control that matters most: huge, red while recording, with a live level bar. */
export function RecordButton({ paused, inputMethod, level, speaking, onPress }: RecordButtonProps) {
  const label = paused ? "Resume recording" : "Pause recording";
  const status = paused
    ? "PAUSED — not listening"
    : inputMethod === "typing"
      ? "Type below — speech not available"
      : speaking
        ? "RECORDING — hearing speech"
        : "RECORDING";
  return (
    <View style={styles.recordWrap}>
      <View style={[styles.indicator, paused ? styles.indicatorPaused : styles.indicatorLive]} testID="recording-indicator" accessibilityLiveRegion="polite">
        <View style={[styles.dot, { backgroundColor: paused ? colors.textMuted : colors.recording }]} />
        <Text style={[styles.indicatorText, { color: paused ? colors.text : colors.recording }]}>{status}</Text>
      </View>
      {inputMethod === "audio" && !paused ? (
        <View style={styles.meter} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View style={[styles.meterFill, { width: `${Math.round(level * 100)}%` }]} />
        </View>
      ) : null}
      <Pressable
        testID="record-toggle"
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={({ pressed }) => [styles.record, paused ? styles.recordPaused : styles.recordLive, pressed && { opacity: 0.8 }]}
      >
        <Text style={[styles.recordText, paused && { color: colors.text }]}>{paused ? "▶  RESUME" : "❚❚  PAUSE"}</Text>
      </Pressable>
    </View>
  );
}

// --- connectivity ----------------------------------------------------------------------------

export function ConnectivityPill({ info }: { info: ConnectionInfo }) {
  const queued = info.queued > 0 ? ` · ${info.queued} waiting to send` : "";
  switch (info.state) {
    case "online":
      return <Pill testID="connectivity" label={`● Online${queued}`} fg={colors.success} bg={colors.successBg} />;
    case "connecting":
      return <Pill testID="connectivity" label="Connecting…" fg={colors.info} bg={colors.infoBg} />;
    case "reconnecting":
      return <Pill testID="connectivity" label={`○ Offline — saving on device${queued}`} fg={colors.warning} bg={colors.warningBg} />;
    case "closed":
      return <Pill testID="connectivity" label={`Disconnected${info.closedReason ? `: ${info.closedReason}` : ""}`} fg={colors.danger} bg={colors.dangerBg} />;
  }
}

// --- speaker picker --------------------------------------------------------------------------

export function SpeakerPicker({ crew, selected, onSelect }: { crew: CrewEntry[]; selected: string; onSelect: (id: string) => void }) {
  return (
    <View style={styles.block}>
      <Text style={styles.label}>Who is speaking?</Text>
      <Row>
        {crew.map((c) => (
          <Chip key={c.user_id} label={c.name} selected={c.user_id === selected} onPress={() => onSelect(c.user_id)} testID={`speaker-${c.user_id}`} />
        ))}
      </Row>
    </View>
  );
}

// --- typed input ------------------------------------------------------------------------------

export function TypeInstead({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const submit = () => {
    if (!text.trim()) return;
    onSend(text);
    setText("");
  };
  return (
    <View style={styles.block}>
      <Text style={styles.label}>Type instead</Text>
      <View style={styles.typeRow}>
        <TextInput
          testID="type-input"
          accessibilityLabel="Type what was said"
          value={text}
          onChangeText={setText}
          onSubmitEditing={submit}
          returnKeyType="send"
          placeholder="e.g. We're isolating the LV at the pillar"
          placeholderTextColor={colors.textMuted}
          style={styles.typeInput}
        />
        <BigButton testID="type-send" label="Send" onPress={submit} disabled={!text.trim()} style={styles.sendButton} />
      </View>
    </View>
  );
}

// --- spoken prompt ----------------------------------------------------------------------------

export function PromptCard({ prompt, onDismiss }: { prompt: VoicePrompt; onDismiss: () => void }) {
  return (
    <Card style={styles.prompt}>
      <Text style={styles.promptLabel}>CREWBRIEF IS ASKING</Text>
      <Text style={styles.promptText} accessibilityLiveRegion="assertive" testID="voice-prompt">
        {prompt.text}
      </Text>
      <BigButton label="Got it" variant="secondary" onPress={onDismiss} />
    </Card>
  );
}

const styles = StyleSheet.create({
  recordWrap: { gap: space.md },
  indicator: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 3 },
  indicatorLive: { borderColor: colors.recording, backgroundColor: colors.dangerBg },
  indicatorPaused: { borderColor: colors.border, backgroundColor: colors.surface },
  dot: { width: 20, height: 20, borderRadius: 10 },
  indicatorText: { fontSize: font.large, fontWeight: "900", flexShrink: 1 },
  meter: { height: 10, borderRadius: 5, backgroundColor: colors.surface, overflow: "hidden" },
  meterFill: { height: 10, backgroundColor: colors.recording },
  record: { minHeight: touch.record, borderRadius: radius.lg, alignItems: "center", justifyContent: "center", borderWidth: 4 },
  recordLive: { backgroundColor: colors.recording, borderColor: colors.recording },
  recordPaused: { backgroundColor: colors.bg, borderColor: colors.text },
  recordText: { fontSize: font.huge, fontWeight: "900", color: "#FFFFFF" },
  block: { gap: space.sm },
  label: { fontSize: font.body, fontWeight: "800", color: colors.text },
  typeRow: { flexDirection: "row", gap: space.sm, alignItems: "stretch" },
  typeInput: {
    flex: 1,
    minWidth: 0, // let the field shrink on narrow phones instead of pushing Send off-screen
    minHeight: touch.primary,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    fontSize: font.body,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  sendButton: { paddingHorizontal: space.lg, flexShrink: 0 },
  prompt: { backgroundColor: colors.warningBg, borderColor: colors.warning, borderWidth: 3 },
  promptLabel: { fontSize: font.small, fontWeight: "900", color: colors.warning },
  promptText: { fontSize: font.large, fontWeight: "800", color: colors.text },
});
