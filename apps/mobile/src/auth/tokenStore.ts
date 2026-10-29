import * as SecureStore from "expo-secure-store";

import type { StoredSession, TokenStore } from "./tokenStore.types";

const KEY = "crewbrief.auth";

/** Native: the token lives in the iOS Keychain / Android Keystore via expo-secure-store. */
export const tokenStore: TokenStore = {
  async load() {
    const raw = await SecureStore.getItemAsync(KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  },
  async save(session: StoredSession) {
    await SecureStore.setItemAsync(KEY, JSON.stringify(session));
  },
  async clear() {
    await SecureStore.deleteItemAsync(KEY);
  },
};
