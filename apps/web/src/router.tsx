import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Link, NavLink, Outlet, redirect, useRouteError } from "react-router";
import { queryClient } from "./runtime";

/** Baked at build time (vite define). The line lets an operator compare the served
 * bundle with the API's /health/ready build field (audit WEB-A-004/WEB-A-009). */
declare const __KR_WEB_BUILD__: string;
const webBuild = typeof __KR_WEB_BUILD__ === "string" ? __KR_WEB_BUILD__ : "unknown";

// The build flag is false for every shipped bundle; only acceptance builds include doubles.
declare const __KR_TEST_HARNESS__: boolean;

function AppShell() {
  return <QueryClientProvider client={queryClient}>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <header className="app-header">
      <div><span className="brand-mark" aria-hidden="true">KR</span><strong>KavaRoutes</strong><span className="environment">Product testing</span></div>
      <nav aria-label="Primary"><NavLink to="/dispatch">Dispatch</NavLink><NavLink to="/tracking">Active drivers</NavLink><NavLink to="/route-history">Route history</NavLink><NavLink to="/clients">Clients</NavLink><NavLink to="/accounting">Accounting</NavLink><NavLink to="/command">Command</NavLink></nav>
    </header>
    <Outlet />
    <footer className="app-footer"><span>Web build {webBuild}</span></footer>
  </QueryClientProvider>;
}

function DriverShell() {
  return <QueryClientProvider client={queryClient}>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <header className="app-header driver-app-header">
      <div><span className="brand-mark" aria-hidden="true">KR</span><strong>KavaRoutes Driver</strong></div>
    </header>
    <Outlet />
    <footer className="app-footer"><span>Driver web build {webBuild}</span></footer>
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
    { path: "dispatch", lazy: () => __KR_TEST_HARNESS__ ? import("./test-support/routes/dispatch-route") : import("./routes/cloud-dispatch-route") },
    { path: "tracking", lazy: () => import("./routes/cloud-tracking-route") },
    { path: "route-history", lazy: () => import("./routes/cloud-route-history-route") },
    { path: "clients", lazy: () => __KR_TEST_HARNESS__ ? import("./test-support/routes/facility-route") : import("./routes/cloud-clients-route") },
    { path: "accounting", lazy: () => import("./routes/cloud-accounting-route") },
    { path: "command", lazy: () => import("./routes/cloud-command-route") },
    { path: "forbidden", lazy: () => import("./routes/forbidden-route") },
    { path: "session-expired", lazy: () => import("./routes/session-expired-route") },
    { path: "*", element: <NotFound /> },
  ],
}, {
  path: "/driver", element: <DriverShell />, errorElement: <RootError />, HydrateFallback,
  children: [{ index: true, lazy: () => import("./routes/cloud-driver-route") }],
}]);
