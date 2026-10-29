import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/endpoints";
import type { User } from "../api/types";
import { useToast } from "../components/Toasts";
import { useAuth } from "./AuthProvider";

export type Area = "crew" | "supervisor";

export function isSupervisor(user: User | null | undefined): boolean {
  return !!user && user.roles.some((r) => r === "supervisor" || r === "safety_admin");
}

export function isCrew(user: User | null | undefined): boolean {
  return !!user && user.roles.includes("crew");
}

export function fitsArea(user: User | null | undefined, area: Area): boolean {
  return area === "crew" ? isCrew(user) : isSupervisor(user);
}

/** Where a user lands after sign-in: supervisors review, crew brief. */
export function homeFor(user: User | null | undefined): string {
  if (isSupervisor(user)) return "/sessions";
  return "/crew";
}

/** Is `path` inside an area this user may open? */
export function canOpen(user: User | null | undefined, path: string): boolean {
  if (path.startsWith("/crew")) return isCrew(user);
  if (path.startsWith("/sessions") || path.startsWith("/metrics")) return isSupervisor(user);
  return false;
}

export const devUsersQuery = { queryKey: ["dev-users"] as const, queryFn: api.devUsers, staleTime: 60 * 60 * 1000 };

/**
 * Demo convenience: open the other side of the product. In dev auth mode this signs in as a
 * suitable seeded user first (preferring `preferred` ids, e.g. the session's supervisor or crew);
 * with Entra it simply navigates and the route guard decides.
 */
export function useSwitchArea() {
  const { mode, user, loginAs } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  return useCallback(
    async (area: Area, path: string, preferred: (string | null | undefined)[] = []) => {
      if (mode !== "dev" || fitsArea(user, area)) {
        navigate(path);
        return;
      }
      try {
        const users = await queryClient.fetchQuery(devUsersQuery);
        const byId = new Map(users.map((u) => [u.id, u]));
        const target =
          preferred.map((id) => (id ? byId.get(id) : undefined)).find((u) => fitsArea(u, area)) ??
          users.find((u) => fitsArea(u, area));
        if (!target) {
          toast.push("warning", `No ${area} user to switch to`);
          return;
        }
        await loginAs(target.id);
        toast.push("info", `Signed in as ${target.name}`);
        navigate(path);
      } catch (err) {
        toast.error(err, "Could not switch user");
      }
    },
    [mode, user, loginAs, navigate, queryClient, toast],
  );
}
