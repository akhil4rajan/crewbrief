import type { ExpoConfig } from "expo/config";

/**
 * Runtime endpoints come from EXPO_PUBLIC_* variables. Expo inlines them into the bundle at
 * build time; they are also copied into `extra` so native builds can read them via
 * expo-constants. Nothing secret belongs here: these values ship inside the app.
 */
const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:8001";
const gatewayUrl = process.env.EXPO_PUBLIC_GATEWAY_URL ?? "http://localhost:8000";
const authMode = process.env.EXPO_PUBLIC_AUTH_MODE ?? "dev";

const MIC_REASON =
  "CrewBrief records the pre-job briefing so the hazard form can be drafted. Recording can be paused at any time.";
const SPEECH_REASON = "CrewBrief transcribes the briefing on the device when cloud speech is unavailable.";

const config: ExpoConfig = {
  name: "CrewBrief",
  slug: "crewbrief",
  scheme: "crewbrief",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  ios: {
    supportsTablet: true,
    bundleIdentifier: "dev.crewbrief.mobile",
    infoPlist: { NSMicrophoneUsageDescription: MIC_REASON },
  },
  android: {
    package: "dev.crewbrief.mobile",
    adaptiveIcon: {
      backgroundColor: "#0B1F33",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    permissions: ["android.permission.RECORD_AUDIO"],
    predictiveBackGestureEnabled: false,
  },
  web: {
    favicon: "./assets/favicon.png",
    bundler: "metro",
    output: "single",
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-audio", { microphonePermission: MIC_REASON }],
    "expo-web-browser",
    [
      "expo-speech-recognition",
      { microphonePermission: MIC_REASON, speechRecognitionPermission: SPEECH_REASON },
    ],
  ],
  extra: {
    apiBaseUrl,
    gatewayUrl,
    authMode,
    entraTenantId: process.env.EXPO_PUBLIC_ENTRA_TENANT_ID ?? "",
    entraClientId: process.env.EXPO_PUBLIC_ENTRA_CLIENT_ID ?? "",
    entraScopes: process.env.EXPO_PUBLIC_ENTRA_SCOPES ?? "",
  },
};

export default config;
