import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, font, radius, space, touch } from "./theme";

// --- layout --------------------------------------------------------------------------------

export function Screen({ children, scroll = true, footer }: { children: ReactNode; scroll?: boolean; footer?: ReactNode }) {
  const body = <View style={styles.content}>{children}</View>;
  return (
    <SafeAreaView style={styles.screen} edges={["bottom", "left", "right"]}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {body}
        </ScrollView>
      ) : (
        body
      )}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </SafeAreaView>
  );
}

export function Card({ title, right, children, style }: { title?: string; right?: ReactNode; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.card, style]}>
      {title ? (
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle} accessibilityRole="header">
            {title}
          </Text>
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

// --- text ----------------------------------------------------------------------------------

export function Title({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.title} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Body({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: object }) {
  return <Text style={[styles.body, muted && styles.muted, style]}>{children}</Text>;
}

// --- controls ------------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

interface BigButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  hint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function BigButton({ label, onPress, variant = "primary", disabled, loading, hint, testID, style }: BigButtonProps) {
  const inactive = disabled || loading;
  const v = buttonVariants[variant];
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: v.bg, borderColor: v.border },
        pressed && styles.pressed,
        inactive && styles.disabled,
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={v.fg} /> : <Text style={[styles.buttonText, { color: v.fg }]}>{label}</Text>}
    </Pressable>
  );
}

const buttonVariants: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
  primary: { bg: colors.primary, fg: colors.primaryText, border: colors.primary },
  secondary: { bg: colors.bg, fg: colors.primary, border: colors.primary },
  danger: { bg: colors.danger, fg: "#FFFFFF", border: colors.danger },
  ghost: { bg: "transparent", fg: colors.primary, border: "transparent" },
};

export function Chip({ label, selected, onPress, testID }: { label: string; selected: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
        {selected ? "✓ " : ""}
        {label}
      </Text>
    </Pressable>
  );
}

export function Field({ label, ...input }: { label: string } & TextInputProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.textMuted}
        style={[styles.input, input.multiline && styles.inputMultiline]}
        {...input}
      />
    </View>
  );
}

// --- feedback ------------------------------------------------------------------------------

type BannerKind = "error" | "warning" | "info" | "success";

const bannerColors: Record<BannerKind, { fg: string; bg: string }> = {
  error: { fg: colors.danger, bg: colors.dangerBg },
  warning: { fg: colors.warning, bg: colors.warningBg },
  info: { fg: colors.info, bg: colors.infoBg },
  success: { fg: colors.success, bg: colors.successBg },
};

export function Banner({ kind, message, onDismiss }: { kind: BannerKind; message: string; onDismiss?: () => void }) {
  const c = bannerColors[kind];
  return (
    <View
      style={[styles.banner, { backgroundColor: c.bg, borderColor: c.fg }]}
      accessibilityRole={kind === "error" ? "alert" : "summary"}
      accessibilityLiveRegion="polite"
    >
      <Text style={[styles.bannerText, { color: c.fg }]}>{message}</Text>
      {onDismiss ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={onDismiss} hitSlop={16} style={styles.bannerClose}>
          <Text style={[styles.bannerText, { color: c.fg }]}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Pill({ label, fg, bg, testID }: { label: string; fg: string; bg: string; testID?: string }) {
  return (
    <View style={[styles.pill, { backgroundColor: bg }]} testID={testID}>
      <Text style={[styles.pillText, { color: fg }]}>{label}</Text>
    </View>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator size="large" color={colors.primary} />
      <Body muted>{label}</Body>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1 },
  content: { width: "100%", maxWidth: 720, alignSelf: "center", padding: space.lg, gap: space.lg },
  footer: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    padding: space.lg,
    gap: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.md,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  cardTitle: { fontSize: font.large, fontWeight: "800", color: colors.text, flexShrink: 1 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" },
  title: { fontSize: font.title, fontWeight: "800", color: colors.text },
  body: { fontSize: font.body, color: colors.text, lineHeight: 26 },
  muted: { color: colors.textMuted },
  button: {
    minHeight: touch.primary,
    borderRadius: radius.md,
    borderWidth: 3,
    paddingHorizontal: space.xl,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: font.large, fontWeight: "800", textAlign: "center" },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.45 },
  chip: {
    minHeight: touch.min,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    justifyContent: "center",
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: font.body, fontWeight: "700", color: colors.text },
  chipTextSelected: { color: colors.primaryText },
  field: { gap: space.xs },
  label: { fontSize: font.body, fontWeight: "700", color: colors.text },
  input: {
    minHeight: touch.min,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    fontSize: font.body,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  inputMultiline: { minHeight: 96, paddingVertical: space.md, textAlignVertical: "top" },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 2,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  bannerText: { fontSize: font.body, fontWeight: "700", flexShrink: 1, flexGrow: 1 },
  bannerClose: { padding: space.xs },
  pill: { borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs, alignSelf: "flex-start" },
  pillText: { fontSize: font.small, fontWeight: "800" },
  loading: { alignItems: "center", justifyContent: "center", padding: space.xxl, gap: space.md },
});
