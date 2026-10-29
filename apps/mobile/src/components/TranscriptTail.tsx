import { StyleSheet, Text, View } from "react-native";

import type { TranscriptSegment } from "@/api/types";
import { Card } from "@/ui/primitives";
import { colors, font } from "@/ui/theme";

interface Props {
  segments: TranscriptSegment[];
  interim: string;
  nameOf: (userId: string | null | undefined) => string;
}

/** The last few transcript lines, so the crew can see they are being heard correctly. */
export function TranscriptTail({ segments, interim, nameOf }: Props) {
  return (
    <Card title="What I heard">
      {segments.length === 0 && !interim ? <Text style={styles.empty}>Nothing yet.</Text> : null}
      {segments.map((s) => (
        <View key={s.id} style={[styles.line, s.filtered && styles.filtered]}>
          <Text style={styles.speaker}>{s.speaker_name || nameOf(s.user_id) || s.speaker_id}</Text>
          <Text style={styles.text}>
            {s.text}
            {s.filtered ? <Text style={styles.reason}>{`  (ignored: ${s.filter_reason ?? "off topic"})`}</Text> : null}
          </Text>
        </View>
      ))}
      {interim ? (
        <View style={styles.line}>
          <Text style={styles.speaker}>Listening…</Text>
          <Text style={[styles.text, styles.interim]}>{interim}</Text>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  empty: { fontSize: font.body, color: colors.textMuted, fontStyle: "italic" },
  line: { gap: 2 },
  filtered: { opacity: 0.55 },
  speaker: { fontSize: font.small, fontWeight: "800", color: colors.primary },
  text: { fontSize: font.body, color: colors.text },
  interim: { color: colors.textMuted, fontStyle: "italic" },
  reason: { fontSize: font.small, color: colors.textMuted },
});
