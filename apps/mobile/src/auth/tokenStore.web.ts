import type { StoredSession, TokenStore } from "./tokenStore.types";

const KEY = "crewbrief.auth";

/**
 * Web: sessionStorage, so the token dies with the tab and is never shared across tabs.
 * Storage can throw (private mode, blocked site data); the app then simply asks to sign in.
 */
export const tokenStore: TokenStore = {
  async load() {
    try {
      const raw = window.sessionStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as StoredSession) : null;
    } catch {
      return null;
    }
  },
  async save(session: StoredSession) {
    try {
      window.sessionStorage.setItem(KEY, JSON.stringify(session));
    } catch {
      // Not persisted; the in-memory session still works for this page load.
    }
  },
  async clear() {
    try {
      window.sessionStorage.removeItem(KEY);
    } catch {
      // Nothing to clear.
    }
  },
};
