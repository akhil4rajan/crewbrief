import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, ApiError } from "@/api/client";
import type { User } from "@/api/types";
import { authProvider } from "./providers";
import { tokenStore } from "./tokenStore";

type AuthStatus = "loading" | "signedOut" | "signedIn";

interface AuthState {
  status: AuthStatus;
  user: User | null;
  token: string | null;
}

interface AuthContextValue extends AuthState {
  signIn(opts?: { userId?: string }): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading", user: null, token: null });
  // The API client reads the token synchronously on every request.
  const tokenRef = useRef<string | null>(null);

  const signOut = useCallback(async () => {
    tokenRef.current = null;
    setState({ status: "signedOut", user: null, token: null });
    await tokenStore.clear();
  }, []);

  useEffect(() => {
    api.configure(() => tokenRef.current, () => void signOut());
  }, [signOut]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await tokenStore.load().catch(() => null);
      if (cancelled) return;
      if (!stored) {
        setState({ status: "signedOut", user: null, token: null });
        return;
      }
      tokenRef.current = stored.token;
      setState({ status: "signedIn", user: stored.user, token: stored.token });
      // Refresh the profile, but stay signed in when offline: crews often start with no signal.
      try {
        const user = await api.me(stored.token);
        if (!cancelled) setState((s) => ({ ...s, user }));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401 && !cancelled) await signOut();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signOut]);

  const signIn = useCallback(async (opts?: { userId?: string }) => {
    const session = await authProvider.signIn(opts);
    tokenRef.current = session.token;
    await tokenStore.save(session);
    setState({ status: "signedIn", user: session.user, token: session.token });
  }, []);

  const value = useMemo(() => ({ ...state, signIn, signOut }), [state, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** Signed-in user; only call from screens rendered behind the auth guard. */
export function useCurrentUser(): User {
  const { user } = useAuth();
  if (!user) throw new Error("No signed-in user");
  return user;
}
