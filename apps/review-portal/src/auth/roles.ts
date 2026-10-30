import { api } from "../api/endpoints";
import type { User } from "../api/types";

/** CrewBrief is one app for the crew: whoever leads the briefing also reviews and submits it. */
export function isCrew(user: User | null | undefined): boolean {
  return !!user && user.roles.includes("crew");
}

/** Where a user lands after sign-in. */
export const HOME = "/crew";

/** Is `path` a page this user may open after sign-in? */
export function canOpen(user: User | null | undefined, path: string): boolean {
  return path.startsWith("/crew") && isCrew(user);
}

export const devUsersQuery = { queryKey: ["dev-users"] as const, queryFn: api.devUsers, staleTime: 60 * 60 * 1000 };
