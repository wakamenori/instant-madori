import { useSyncExternalStore } from "react";
import type { MouseEvent, ReactNode } from "react";
import { formatRoute, parseRoute } from "./route.ts";
import type { Route } from "./route.ts";

type Linkable = Exclude<Route, { kind: "not_found" }>;

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, () => window.location.pathname);
  return parseRoute(pathname);
}

export function navigate(route: Linkable, options: { replace?: boolean } = {}): void {
  const path = formatRoute(route);
  if (path === window.location.pathname) return;
  if (options.replace === true) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  for (const listener of listeners) listener();
}

export function RouteLink({ to, children }: { to: Linkable; children: ReactNode }) {
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    navigate(to);
  }
  return (
    <a href={formatRoute(to)} onClick={onClick}>
      {children}
    </a>
  );
}
