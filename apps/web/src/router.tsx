import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Link, NavLink, Outlet, redirect, useRouteError } from "react-router";
import { queryClient } from "./runtime";

/** Baked at build time (vite define). The line lets an operator compare the served
 * bundle with the API's /health/ready build field (audit WEB-A-004/WEB-A-009). */
declare const __KR_WEB_BUILD__: string;
const webBuild = typeof __KR_WEB_BUILD__ === "string" ? __KR_WEB_BUILD__ : "unknown";

// One backend per build, and the default is the persisted one. The
// fixture-backed `local-synthetic` surface is opt-in for the browser test
// harness only, so no synthetic route ships unless a build asks for it.
const backendMode = import.meta.env.VITE_KAVAROUTES_BACKEND ?? "private-cloud";
if (!["local-synthetic", "private-cloud"].includes(backendMode)) throw new Error("INVALID_BACKEND_MODE");
const privateCloud = backendMode === "private-cloud";

function AppShell() {
  return <QueryClientProvider client={queryClient}>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <header className="app-header">
      <div><span className="brand-mark" aria-hidden="true">KR</span><strong>KavaRoutes</strong><span className="environment">Product testing</span></div>
      <nav aria-label="Primary"><NavLink to="/dispatch">Dispatch</NavLink><NavLink to="/clients">Clients</NavLink><NavLink to="/accounting">Accounting</NavLink><NavLink to="/command">Command</NavLink><NavLink to="/driver">Driver</NavLink></nav>
    </header>
    <Outlet />
    <footer className="app-footer"><span>Web build {webBuild}</span></footer>
  </QueryClientProvider>;
}

function RootError() {
  const error = useRouteError();
  return <main id="main-content" className="message-page"><h1>We could not open this view</h1><p role="alert">{error instanceof Error ? error.message : "Unexpected local error"}</p><Link to="/dispatch">Return to Dispatch</Link></main>;
}

function NotFound() { return <main id="main-content" className="message-page"><h1>Page not found</h1><p>This local route is not part of the closed KavaRoutes catalog.</p><Link to="/dispatch">Open Dispatch</Link></main>; }

function HydrateFallback() {
  return <main id="main-content" className="message-page"><p role="status">Loading KavaRoutes…</p></main>;
}

// A lazy route hydrates before its module is ready; without this the router warns on
// every page and the operator sees an empty root.
export const router = createBrowserRouter([{
  path: "/", element: <AppShell />, errorElement: <RootError />, HydrateFallback, children: [
    { index: true, loader: () => redirect("/dispatch") },
    { path: "dispatch", lazy: () => privateCloud ? import("./routes/cloud-dispatch-route") : import("./routes/dispatch-route") },
    { path: "driver", lazy: () => import("./routes/cloud-driver-route") },
    { path: "clients", lazy: () => privateCloud ? import("./routes/cloud-clients-route") : import("./routes/facility-route") },
    { path: "accounting", lazy: () => import("./routes/cloud-accounting-route") },
    { path: "command", lazy: () => import("./routes/cloud-command-route") },
    { path: "forbidden", lazy: () => import("./routes/forbidden-route") },
    { path: "session-expired", lazy: () => import("./routes/session-expired-route") },
    { path: "*", element: <NotFound /> },
  ],
}]);
