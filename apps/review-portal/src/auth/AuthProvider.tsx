import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { configureAuth } from "../api/client";
import type { User, UserRole } from "../api/types";
import { config, type AuthMode } from "../config";
import { DevAuth } from "./devAuth";
import { EntraAuth } from "./entraAuth";

type Status = "loading" | "anonymous" | "authenticated";

export interface AuthContextValue {
  mode: AuthMode;
  status: Status;
  user: User | null;
  error: string | null;
  /** Dev mode: sign in as a seeded user. */
  loginAs: (userId: string) => Promise<void>;
  /** Entra mode: start the redirect sign-in. */
  loginWithEntra: () => Promise<void>;
  logout: () => Promise<void>;
  getToken: () => Promise<string | null>;
  hasRole: (...roles: UserRole[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const devBackend = new DevAuth();
const backend = config.authMode === "entra" ? new EntraAuth(config.entra) : devBackend;

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signedOut = useCallback(() => {
    setUser(null);
    setStatus("anonymous");
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    configureAuth(
      () => backend.getToken(),
      () => {
        void backend.logout().finally(() => {
          setError("Your sign-in has expired. Please sign in again.");
          signedOut();
        });
      },
    );
    let cancelled = false;
    backend
      .restore()
      .then((u) => {
        if (cancelled) return;
        setUser(u);
        setStatus(u ? "authenticated" : "anonymous");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Sign-in failed");
        setStatus("anonymous");
      });
    return () => {
      cancelled = true;
    };
  }, [signedOut]);

  const loginAs = useCallback(async (userId: string) => {
    setError(null);
    const u = await devBackend.loginAs(userId);
    setUser(u);
    setStatus("authenticated");
  }, []);

  const loginWithEntra = useCallback(async () => {
    setError(null);
    if (backend instanceof EntraAuth) await backend.login();
  }, []);

  const logout = useCallback(async () => {
    await backend.logout();
    signedOut();
  }, [signedOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      mode: config.authMode,
      status,
      user,
      error,
      loginAs,
      loginWithEntra,
      logout,
      getToken: () => backend.getToken(),
      hasRole: (...roles) => !!user && roles.some((r) => user.roles.includes(r)),
    }),
    [status, user, error, loginAs, loginWithEntra, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
