import { api } from "../api/endpoints";
import type { User } from "../api/types";
import type { AuthBackend } from "./backend";

const STORAGE_KEY = "crewbrief.devAuth";

interface Stored {
  token: string;
  user: User;
}

function tokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
    return typeof payload.exp === "number" && payload.exp * 1000 < Date.now() + 30_000;
  } catch {
    return true;
  }
}

/**
 * Local development sign-in: pick a seeded user, the form API mints a short-lived JWT.
 * The token lives in sessionStorage so it is scoped to the tab and cleared when it closes.
 */
export class DevAuth implements AuthBackend {
  private stored: Stored | null = null;

  async restore(): Promise<User | null> {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as Stored) : null;
      if (parsed && !tokenExpired(parsed.token)) {
        this.stored = parsed;
        return parsed.user;
      }
    } catch {
      // Storage unavailable or corrupt: fall through to signed-out.
    }
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }

  async loginAs(userId: string): Promise<User> {
    const res = await api.devToken(userId);
    this.stored = { token: res.access_token, user: res.user };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.stored));
    return res.user;
  }

  async getToken(): Promise<string | null> {
    if (this.stored && tokenExpired(this.stored.token)) return null;
    return this.stored?.token ?? null;
  }

  async logout(): Promise<void> {
    this.stored = null;
    sessionStorage.removeItem(STORAGE_KEY);
  }
}
