import type { AccountInfo, IPublicClientApplication } from "@azure/msal-browser";
import { api } from "../api/endpoints";
import type { User } from "../api/types";
import type { EntraConfig } from "../config";
import type { AuthBackend } from "./backend";

/**
 * Entra ID sign-in via MSAL (redirect flow). App roles (crew / supervisor / safety_admin) come
 * from the access token's `roles` claim, which the form API reads; `/api/me` returns the user.
 * MSAL is imported lazily so dev-mode bundles never load it.
 */
export class EntraAuth implements AuthBackend {
  private msal: IPublicClientApplication | null = null;

  constructor(private readonly cfg: EntraConfig) {}

  private async client(): Promise<IPublicClientApplication> {
    if (this.msal) return this.msal;
    if (!this.cfg.clientId) throw new Error("Entra sign-in is not configured (VITE_ENTRA_CLIENT_ID is empty)");
    const { PublicClientApplication } = await import("@azure/msal-browser");
    const app = await PublicClientApplication.createPublicClientApplication({
      auth: { clientId: this.cfg.clientId, authority: this.cfg.authority, redirectUri: window.location.origin },
      cache: { cacheLocation: "sessionStorage" },
    });
    this.msal = app;
    return app;
  }

  private account(app: IPublicClientApplication): AccountInfo | null {
    return app.getActiveAccount() ?? app.getAllAccounts()[0] ?? null;
  }

  async restore(): Promise<User | null> {
    const app = await this.client();
    const result = await app.handleRedirectPromise();
    if (result?.account) app.setActiveAccount(result.account);
    if (!this.account(app)) return null;
    const token = await this.getToken();
    return token ? api.me(token) : null;
  }

  async login(): Promise<void> {
    const app = await this.client();
    await app.loginRedirect({ scopes: this.cfg.scopes });
  }

  async getToken(): Promise<string | null> {
    const app = await this.client();
    const account = this.account(app);
    if (!account) return null;
    const { InteractionRequiredAuthError } = await import("@azure/msal-browser");
    try {
      const res = await app.acquireTokenSilent({ scopes: this.cfg.scopes, account });
      return res.accessToken;
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
        await app.acquireTokenRedirect({ scopes: this.cfg.scopes, account });
        return null;
      }
      throw err;
    }
  }

  async logout(): Promise<void> {
    const app = await this.client();
    await app.logoutRedirect({ account: this.account(app), postLogoutRedirectUri: window.location.origin });
  }
}
