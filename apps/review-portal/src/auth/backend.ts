import type { User } from "../api/types";

/** Both auth modes implement this, so the rest of the app never branches on the mode. */
export interface AuthBackend {
  /** Restore a previous sign-in (page reload, redirect return). */
  restore(): Promise<User | null>;
  /** Current access token, refreshed if the backend supports it. */
  getToken(): Promise<string | null>;
  logout(): Promise<void>;
}
