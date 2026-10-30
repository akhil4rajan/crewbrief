/**
 * Runtime configuration.
 *
 * Precedence: `window.__CREWBRIEF_CONFIG__` (written to /config.js by the container at start-up,
 * so one image serves every environment) → Vite build-time `VITE_*` variables → local defaults.
 */

export type AuthMode = "dev" | "entra";

export interface EntraConfig {
  clientId: string;
  authority: string;
  scopes: string[];
}

export interface AppConfig {
  apiBaseUrl: string;
  gatewayUrl: string;
  authMode: AuthMode;
  entra: EntraConfig;
  /** Organisation shown on the JSEA form header (a made-up demo company by default). */
  orgName: string;
  /** Form number and revision printed on the JSEA header. */
  formId: string;
}

interface RawConfig {
  apiBaseUrl?: string;
  gatewayUrl?: string;
  authMode?: string;
  entraClientId?: string;
  entraAuthority?: string;
  entraScopes?: string[] | string;
  orgName?: string;
  formId?: string;
}

declare global {
  interface Window {
    __CREWBRIEF_CONFIG__?: RawConfig;
  }
}

function pick(...values: (string | undefined)[]): string | undefined {
  return values.find((v) => typeof v === "string" && v.trim() !== "")?.trim();
}

function splitScopes(raw: string[] | string | undefined): string[] {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return (raw ?? "").split(/[\s,]+/).filter(Boolean);
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function load(): AppConfig {
  const rt = window.__CREWBRIEF_CONFIG__ ?? {};
  const env = import.meta.env;
  const authMode = pick(rt.authMode, env.VITE_AUTH_MODE) === "entra" ? "entra" : "dev";
  const runtimeScopes = splitScopes(rt.entraScopes);
  return {
    apiBaseUrl: stripSlash(pick(rt.apiBaseUrl, env.VITE_API_BASE_URL) ?? "http://localhost:8001"),
    gatewayUrl: stripSlash(pick(rt.gatewayUrl, env.VITE_GATEWAY_URL) ?? "http://localhost:8000"),
    authMode,
    entra: {
      clientId: pick(rt.entraClientId, env.VITE_ENTRA_CLIENT_ID) ?? "",
      authority:
        pick(rt.entraAuthority, env.VITE_ENTRA_AUTHORITY) ?? "https://login.microsoftonline.com/common",
      scopes: runtimeScopes.length ? runtimeScopes : splitScopes(env.VITE_ENTRA_SCOPES),
    },
    orgName: pick(rt.orgName, env.VITE_ORG_NAME) ?? "Southern Energy Networks",
    formId: pick(rt.formId, env.VITE_FORM_ID) ?? "SEN-HSE-F014 · Rev 3",
  };
}

export const config: AppConfig = load();

/** http(s)://host → ws(s)://host, for WebSocket endpoints on the gateway. */
export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/i, "ws");
}
