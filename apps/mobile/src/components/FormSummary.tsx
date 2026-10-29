import { StyleSheet, Text, View } from "react-native";

import type { Draft, FieldValue, HazardEntry, Severity } from "@/api/types";
import { Card, Pill, Row } from "@/ui/primitives";
import { colors, font, severityColor, space } from "@/ui/theme";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

function display(field: FieldValue | null | undefined): string | null {
  const v = field?.value;
  if (v === null || v === undefined || v === "") return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

function FieldLine({ label, field, testID, format }: { label: string; field: FieldValue | null | undefined; testID?: string; format?: (v: string) => string }) {
  const raw = display(field);
  const value = raw && format ? format(raw) : raw;
  const ai = field?.provenance?.source === "ai";
  return (
    <View style={styles.fieldLine} testID={testID}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.fieldValue, !value && styles.empty]}>{value ?? "Not heard yet"}</Text>
      {value && ai ? (
        <Text style={styles.meta}>AI · {Math.round((field?.provenance.confidence ?? 0) * 100)}% sure</Text>
      ) : null}
    </View>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const c = severityColor[severity];
  return <Pill label={c.label} fg={c.fg} bg={c.bg} />;
}

function HazardRow({ hazard }: { hazard: HazardEntry }) {
  const controls = Object.values(hazard.controls);
  const highRisk = hazard.severity === "high" || hazard.severity === "critical";
  const noControls = controls.length === 0;
  return (
    <View style={[styles.hazard, { borderLeftColor: severityColor[hazard.severity].bg }]} testID={`hazard-${hazard.code}`}>
      <Row>
        <SeverityBadge severity={hazard.severity} />
        {hazard.status === "unconfirmed" ? <Pill label="NOT DISCUSSED YET" fg={colors.warning} bg={colors.warningBg} /> : null}
      </Row>
      <Text style={styles.hazardName}>{hazard.name}</Text>
      <Text style={[styles.controls, noControls && highRisk && styles.controlsMissing]}>
        {noControls
          ? highRisk
            ? "No controls yet — needs isolation or engineering control"
            : "No controls yet"
          : `${controls.length} control${controls.length === 1 ? "" : "s"}: ${controls.map((c) => c.name).join(", ")}`}
      </Text>
    </View>
  );
}

/** Read-only summary of the draft form, as it fills in live. `taskTypeName` maps codes to names. */
export function FormSummary({ draft, taskTypeName }: { draft: Draft; taskTypeName?: (code: string) => string }) {
  const { form } = draft;
  const hazards = Object.values(form.hazards)
    .filter((h) => h.status !== "not_present")
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const ppe = Object.values(form.ppe);
  const tasks = Object.values(form.tasks).sort((a, b) => a.order - b.order);

  return (
    <View style={styles.wrap}>
      <Card title={`Hazards (${hazards.length})`}>
        {hazards.length === 0 ? <Text style={styles.empty}>No hazards yet. Talk through what could hurt someone.</Text> : null}
        {hazards.map((h) => (
          <HazardRow key={h.code} hazard={h} />
        ))}
      </Card>

      <Card title="Job">
        <FieldLine label="Title" field={form.job.title} />
        <FieldLine label="Task type" field={form.job.task_type} format={taskTypeName} />
        <FieldLine label="Location" field={form.job.location} testID="field-location" />
        <FieldLine label="Description" field={form.job.description} />
        {tasks.length > 0 ? (
          <View style={styles.fieldLine}>
            <Text style={styles.fieldLabel}>Steps</Text>
            {tasks.map((t) => (
              <Text key={t.id} style={styles.fieldValue}>
                {t.order}. {t.description}
              </Text>
            ))}
          </View>
        ) : null}
      </Card>

      <Card title="Emergency">
        <FieldLine label="Muster point" field={form.emergency.muster_point} />
        <FieldLine label="Nearest hospital" field={form.emergency.nearest_hospital} />
        <FieldLine label="First aider" field={form.emergency.first_aider} />
        <FieldLine label="Communications" field={form.emergency.communications} />
      </Card>

      {ppe.length > 0 ? (
        <Card title={`PPE (${ppe.length})`}>
          <Text style={styles.fieldValue}>{ppe.map((p) => p.name).join(", ")}</Text>
        </Card>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.lg },
  fieldLine: { gap: 2 },
  fieldLabel: { fontSize: font.small, fontWeight: "800", color: colors.textMuted, textTransform: "uppercase" },
  fieldValue: { fontSize: font.body, color: colors.text, fontWeight: "600" },
  empty: { fontSize: font.body, color: colors.textMuted, fontStyle: "italic", fontWeight: "400" },
  meta: { fontSize: font.small, color: colors.textMuted },
  hazard: { borderLeftWidth: 8, paddingLeft: space.md, paddingVertical: space.sm, gap: space.xs, backgroundColor: colors.bg, borderRadius: 6 },
  hazardName: { fontSize: font.large, fontWeight: "800", color: colors.text },
  controls: { fontSize: font.body, color: colors.text },
  controlsMissing: { color: colors.danger, fontWeight: "800" },
});
