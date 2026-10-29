import { Pressable, StyleSheet, Text } from "react-native";

import { BigButton, Card } from "@/ui/primitives";
import { colors, font, radius, space, touch } from "@/ui/theme";

export interface TapInMember {
  userId: string;
  name: string;
  checkedIn: boolean;
}

/** Each crew member taps their own name so the form knows who is present. */
export function CrewTapIn({ members, busyId, onTap }: { members: TapInMember[]; busyId: string | null; onTap: (userId: string) => void }) {
  const present = members.filter((m) => m.checkedIn).length;
  return (
    <Card title={`Tap in (${present}/${members.length})`}>
      <Text style={styles.help}>Everyone on the job: tap your name.</Text>
      {members.map((m) => (
        <Pressable
          key={m.userId}
          testID={`checkin-${m.userId}`}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: m.checkedIn, busy: busyId === m.userId }}
          accessibilityLabel={`${m.name}${m.checkedIn ? ", checked in" : ""}`}
          disabled={m.checkedIn || busyId !== null}
          onPress={() => onTap(m.userId)}
          style={({ pressed }) => [styles.member, m.checkedIn && styles.memberIn, pressed && { opacity: 0.8 }]}
        >
          <Text style={[styles.tick, m.checkedIn && styles.tickIn]}>{m.checkedIn ? "✓" : "○"}</Text>
          <Text style={[styles.name, m.checkedIn && styles.nameIn]}>{m.name}</Text>
          <Text style={[styles.state, m.checkedIn && styles.nameIn]}>
            {busyId === m.userId ? "…" : m.checkedIn ? "Here" : "Tap in"}
          </Text>
        </Pressable>
      ))}
    </Card>
  );
}

/** Recording notice the crew must acknowledge before any audio is captured. */
export function ConsentNotice({ acknowledged, busy, onAcknowledge }: { acknowledged: boolean; busy: boolean; onAcknowledge: () => void }) {
  return (
    <Card title="Recording notice" style={acknowledged ? styles.consentDone : styles.consent}>
      <Text style={styles.consentText}>
        This briefing will be recorded and transcribed so CrewBrief can draft the hazard form.
      </Text>
      <Text style={styles.bullet}>• A red banner shows whenever recording is active.</Text>
      <Text style={styles.bullet}>• Anyone can ask to pause recording at any time.</Text>
      <Text style={styles.bullet}>• Raw audio is not stored by default — only the transcript, with personal details removed.</Text>
      <Text style={styles.bullet}>• A supervisor reviews the form before it is submitted.</Text>
      {acknowledged ? (
        <Text style={styles.ack} testID="consent-done">
          ✓ Crew notified
        </Text>
      ) : (
        <BigButton testID="consent" label="Crew has been told — OK" onPress={onAcknowledge} loading={busy} />
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  help: { fontSize: font.body, color: colors.textMuted },
  member: {
    minHeight: touch.primary,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 3,
    borderColor: colors.primary,
    backgroundColor: colors.bg,
  },
  memberIn: { backgroundColor: colors.success, borderColor: colors.success },
  tick: { fontSize: font.huge, color: colors.primary, width: 36, textAlign: "center" },
  tickIn: { color: "#FFFFFF" },
  name: { flex: 1, fontSize: font.large, fontWeight: "800", color: colors.text },
  nameIn: { color: "#FFFFFF" },
  state: { fontSize: font.body, fontWeight: "800", color: colors.primary },
  consent: { borderColor: colors.warning, borderWidth: 3, backgroundColor: colors.warningBg },
  consentDone: { borderColor: colors.success, borderWidth: 2 },
  consentText: { fontSize: font.body, fontWeight: "700", color: colors.text },
  bullet: { fontSize: font.body, color: colors.text },
  ack: { fontSize: font.large, fontWeight: "900", color: colors.success },
});
