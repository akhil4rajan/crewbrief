import { Redirect, Stack } from "expo-router";
import { Pressable, Text } from "react-native";

import { useAuth } from "@/auth/AuthContext";
import { Loading } from "@/ui/primitives";
import { colors, font } from "@/ui/theme";

/** Everything in (app) requires a signed-in user. */
export default function AppLayout() {
  const { status, user, signOut } = useAuth();
  if (status === "loading") return <Loading label="Signing in…" />;
  if (status !== "signedIn") return <Redirect href="/sign-in" />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: colors.primaryText,
        headerTitleStyle: { fontWeight: "800", fontSize: font.large },
        contentStyle: { backgroundColor: colors.bg },
        headerRight: () => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Sign out ${user?.name ?? ""}`}
            onPress={() => void signOut()}
            hitSlop={12}
            style={{ paddingHorizontal: 12, paddingVertical: 8 }}
          >
            <Text style={{ color: colors.primaryText, fontSize: font.body, fontWeight: "700" }}>Sign out</Text>
          </Pressable>
        ),
      }}
    >
      <Stack.Screen name="index" options={{ title: "My jobs" }} />
      <Stack.Screen name="new" options={{ title: "New briefing" }} />
      <Stack.Screen name="sessions/[id]/prebrief" options={{ title: "Before you start" }} />
      <Stack.Screen name="sessions/[id]/live" options={{ title: "Live briefing", headerBackVisible: false }} />
      <Stack.Screen name="sessions/[id]/review" options={{ title: "Review" }} />
    </Stack>
  );
}
