import { StyleSheet, Text, View } from "react-native";

import type { Gap, GapSeverity } from "@/api/types";
import { Card, Pill } from "@/ui/primitives";
import { colors, font, gapSeverityColor, space } from "@/ui/theme";

const ORDER: GapSeverity[] = ["blocking", "warning", "info"];

/** Open gaps the verifier raised, most serious first. */
export function GapList({ gaps, title = "Still to cover" }: { gaps: Gap[]; title?: string }) {
  const open = gaps.filter((g) => g.status === "open").sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
  return (
    <Card title={`${title} (${open.length})`}>
      {open.length === 0 ? <Text style={styles.none}>Nothing missing right now.</Text> : null}
      {open.map((g) => {
        const c = gapSeverityColor[g.severity];
        return (
          <View key={g.id} style={[styles.gap, { borderColor: c.fg, backgroundColor: c.bg }]} testID={`gap-${g.id}`}>
            <Pill label={g.severity.toUpperCase()} fg={colors.bg} bg={c.fg} />
            <Text style={styles.question}>{g.question || g.message}</Text>
            {g.question ? <Text style={styles.message}>{g.message}</Text> : null}
          </View>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  none: { fontSize: font.body, color: colors.success, fontWeight: "700" },
  gap: { borderWidth: 2, borderRadius: 10, padding: space.md, gap: space.xs },
  question: { fontSize: font.body, fontWeight: "800", color: colors.text },
  message: { fontSize: font.small, color: colors.textMuted },
});
