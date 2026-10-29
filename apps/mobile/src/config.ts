import Constants from "expo-constants";

export type AuthMode = "dev" | "entra";

interface AppConfig {
  apiBaseUrl: string;
  gatewayUrl: string;
  authMode: AuthMode;
  entra: { tenantId: string; clientId: string; scopes: string[] };
}

type Extra = Partial<Record<"apiBaseUrl" | "gatewayUrl" | "authMode" | "entraTenantId" | "entraClientId" | "entraScopes", string>>;

const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

/** EXPO_PUBLIC_* are inlined by Metro at build time; `extra` covers native builds made without them. */
function pick(inlined: string | undefined, fromExtra: string | undefined, fallback: string): string {
  const value = inlined || fromExtra || fallback;
  return value.replace(/\/+$/, "");
}

export const config: AppConfig = {
  apiBaseUrl: pick(process.env.EXPO_PUBLIC_API_BASE_URL, extra.apiBaseUrl, "http://localhost:8001"),
  gatewayUrl: pick(process.env.EXPO_PUBLIC_GATEWAY_URL, extra.gatewayUrl, "http://localhost:8000"),
  authMode: (process.env.EXPO_PUBLIC_AUTH_MODE || extra.authMode) === "entra" ? "entra" : "dev",
  entra: {
    tenantId: process.env.EXPO_PUBLIC_ENTRA_TENANT_ID || extra.entraTenantId || "",
    clientId: process.env.EXPO_PUBLIC_ENTRA_CLIENT_ID || extra.entraClientId || "",
    scopes: (process.env.EXPO_PUBLIC_ENTRA_SCOPES || extra.entraScopes || "openid profile offline_access")
      .split(/[\s,]+/)
      .filter(Boolean),
  },
};

/** ws(s):// form of the gateway base URL. */
export function gatewayWsUrl(path: string): string {
  return config.gatewayUrl.replace(/^http/, "ws") + path;
}
