import { Redirect } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { api, errorMessage } from "@/api/client";
import type { User } from "@/api/types";
import { useAuth } from "@/auth/AuthContext";
import { config } from "@/config";
import { useLoad } from "@/hooks/useLoad";
import { Banner, BigButton, Body, Card, Loading, Screen, Title } from "@/ui/primitives";
import { colors, font, space } from "@/ui/theme";

export default function SignInScreen() {
  const { status, signIn } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (status === "signedIn") return <Redirect href="/" />;

  const run = async (key: string, opts?: { userId?: string }) => {
    setBusy(key);
    setError(null);
    try {
      await signIn(opts);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <View style={styles.hero}>
        <Text style={styles.brand}>CrewBrief</Text>
        <Body muted>Talk through the job. The hazard form fills itself in.</Body>
      </View>
      {error ? <Banner kind="error" message={error} onDismiss={() => setError(null)} /> : null}
      {config.authMode === "entra" ? (
        <Card title="Sign in">
          <BigButton label="Sign in with your work account" loading={busy === "entra"} onPress={() => void run("entra")} />
        </Card>
      ) : (
        <DevUserPicker busy={busy} onPick={(u) => void run(u.id, { userId: u.id })} />
      )}
    </Screen>
  );
}

/** Dev mode: pick one of the seeded users from GET /api/auth/dev-users. */
function DevUserPicker({ busy, onPick }: { busy: string | null; onPick: (u: User) => void }) {
  const { data, error, loading, reload } = useLoad(() => api.devUsers(), []);
  if (loading && !data) return <Loading label="Loading crew…" />;
  if (error) {
    return (
      <Card title="Can't load users">
        <Banner kind="error" message={error} />
        <BigButton label="Try again" variant="secondary" onPress={() => void reload()} />
      </Card>
    );
  }
  const crew = (data ?? []).filter((u) => u.roles.includes("crew"));
  const others = (data ?? []).filter((u) => !u.roles.includes("crew"));
  return (
    <>
      <Title>Who are you?</Title>
      <Body muted>Development sign-in: tap your name.</Body>
      <View style={styles.list}>
        {crew.map((u) => (
          <BigButton key={u.id} testID={`dev-user-${u.id}`} label={u.name} loading={busy === u.id} disabled={!!busy} onPress={() => onPick(u)} />
        ))}
      </View>
      {others.length > 0 ? (
        <View style={styles.list}>
          <Text style={styles.subhead}>Supervisors and safety (use the review portal for sign-off)</Text>
          {others.map((u) => (
            <BigButton key={u.id} testID={`dev-user-${u.id}`} label={u.name} variant="secondary" loading={busy === u.id} disabled={!!busy} onPress={() => onPick(u)} />
          ))}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  hero: { gap: space.sm, paddingVertical: space.xl },
  brand: { fontSize: 40, fontWeight: "900", color: colors.primary },
  list: { gap: space.md },
  subhead: { fontSize: font.body, fontWeight: "700", color: colors.textMuted },
});
