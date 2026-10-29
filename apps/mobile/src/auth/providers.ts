import * as AuthSession from "expo-auth-session";

import { api } from "@/api/client";
import { config, type AuthMode } from "@/config";
import type { StoredSession } from "./tokenStore.types";

/**
 * One interface for every way a crew member can sign in. The screens only ever call
 * `signIn`; which identity provider sits behind it is configuration (EXPO_PUBLIC_AUTH_MODE).
 */
export interface AuthProvider {
  readonly mode: AuthMode;
  /** `userId` is only meaningful in dev mode, where the user is picked from the seeded list. */
  signIn(opts?: { userId?: string }): Promise<StoredSession>;
}

/** Local development: the form API mints HS256 tokens for seeded users (AUTH_MODE=dev). */
export const devAuthProvider: AuthProvider = {
  mode: "dev",
  async signIn(opts) {
    if (!opts?.userId) throw new Error("Pick a crew member to sign in as.");
    const res = await api.devToken(opts.userId);
    return { token: res.access_token, user: res.user };
  },
};

/**
 * Entra ID (production): authorization code + PKCE in the system browser, then the API token is
 * exchanged for the user profile via GET /api/me. Placeholder until the tenant app registration
 * exists; it needs EXPO_PUBLIC_ENTRA_TENANT_ID, EXPO_PUBLIC_ENTRA_CLIENT_ID and the API scope in
 * EXPO_PUBLIC_ENTRA_SCOPES.
 */
export const entraAuthProvider: AuthProvider = {
  mode: "entra",
  async signIn() {
    const { tenantId, clientId, scopes } = config.entra;
    if (!tenantId || !clientId) {
      throw new Error("Entra sign-in is not configured for this build.");
    }
    const discovery = await AuthSession.fetchDiscoveryAsync(`https://login.microsoftonline.com/${tenantId}/v2.0`);
    const redirectUri = AuthSession.makeRedirectUri({ scheme: "crewbrief", path: "auth" });
    const request = new AuthSession.AuthRequest({ clientId, scopes, redirectUri, usePKCE: true });
    const result = await request.promptAsync(discovery);
    if (result.type !== "success" || !result.params.code) {
      throw new Error(result.type === "error" ? result.error?.message ?? "Sign-in failed" : "Sign-in cancelled");
    }
    const tokens = await AuthSession.exchangeCodeAsync(
      {
        clientId,
        code: result.params.code,
        redirectUri,
        extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : undefined,
      },
      discovery,
    );
    const user = await api.me(tokens.accessToken);
    return { token: tokens.accessToken, user };
  },
};

export const authProvider: AuthProvider = config.authMode === "entra" ? entraAuthProvider : devAuthProvider;
