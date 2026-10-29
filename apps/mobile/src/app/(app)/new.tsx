import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { api, errorMessage } from "@/api/client";
import { useCurrentUser } from "@/auth/AuthContext";
import { useLibrary } from "@/hooks/useLibrary";
import { useUsers } from "@/hooks/useUsers";
import { Banner, BigButton, Chip, Field, Loading, Row, Screen } from "@/ui/primitives";
import { colors, font, space } from "@/ui/theme";

export default function NewBriefingScreen() {
  const me = useCurrentUser();
  const library = useLibrary();
  const crewDirectory = useUsers("crew");

  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [taskType, setTaskType] = useState<string | null>(null);
  const [crew, setCrew] = useState<Set<string>>(() => new Set([me.id]));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taskTypes = library.library?.task_types ?? [];
  const toggleCrew = (id: string) =>
    setCrew((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // A sensible default title saves typing with gloves on.
  const effectiveTitle = title.trim() || taskTypes.find((t) => t.code === taskType)?.name || "";

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const detail = await api.createSession({
        title: effectiveTitle,
        task_type: taskType,
        location: location.trim() || null,
        crew_member_ids: [...crew],
      });
      router.replace(`/sessions/${encodeURIComponent(detail.session.id)}/prebrief`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      footer={
        <BigButton
          testID="create-session"
          label="Create briefing"
          onPress={() => void create()}
          loading={saving}
          disabled={!effectiveTitle || crew.size === 0}
        />
      }
    >
      {error ? <Banner kind="error" message={error} onDismiss={() => setError(null)} /> : null}

      <View style={styles.group}>
        <Text style={styles.heading}>What&apos;s the job?</Text>
        {library.loading && !library.library ? <Loading label="Loading task types…" /> : null}
        {library.error ? <Banner kind="warning" message={`Task types unavailable: ${library.error}`} /> : null}
        <Row>
          {taskTypes.map((t) => (
            <Chip
              key={t.code}
              testID={`task-${t.code}`}
              label={t.name}
              selected={taskType === t.code}
              onPress={() => setTaskType(taskType === t.code ? null : t.code)}
            />
          ))}
        </Row>
      </View>

      <Field
        testID="title-input"
        label="Title"
        value={title}
        onChangeText={setTitle}
        placeholder={effectiveTitle || "e.g. Replace LV fuse, pole 1123"}
        maxLength={200}
      />
      <Field testID="location-input" label="Location (optional)" value={location} onChangeText={setLocation} placeholder="Address or asset ID" />

      <View style={styles.group}>
        <Text style={styles.heading}>Who&apos;s on the crew?</Text>
        {crewDirectory.error ? <Banner kind="warning" message={crewDirectory.error} /> : null}
        <Row>
          {crewDirectory.users.map((u) => (
            <Chip key={u.id} testID={`crew-${u.id}`} label={u.id === me.id ? `${u.name} (me)` : u.name} selected={crew.has(u.id)} onPress={() => toggleCrew(u.id)} />
          ))}
        </Row>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { gap: space.sm },
  heading: { fontSize: font.large, fontWeight: "800", color: colors.text },
});
