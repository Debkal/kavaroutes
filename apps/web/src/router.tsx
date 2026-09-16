import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Link, Outlet, redirect, useRouteError } from "react-router";
import { queryClient } from "./runtime";

const privateCloud = import.meta.env.VITE_KAVAROUTES_BACKEND === "private-cloud";
if (import.meta.env.VITE_KAVAROUTES_BACKEND && !["local-synthetic", "private-cloud"].includes(import.meta.env.VITE_KAVAROUTES_BACKEND)) throw new Error("INVALID_BACKEND_MODE");

function AppShell() {
  return <QueryClientProvider client={queryClient}>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <header className="app-header">
      <div><span className="brand-mark" aria-hidden="true">KR</span><strong>KavaRoutes</strong><span className="environment">{privateCloud ? "Private cloud prototype" : "Local synthetic alpha"}</span></div>
      <nav aria-label="Primary"><Link to="/dispatch">Dispatch</Link><Link to="/facility">Facility</Link></nav>
    </header>
    <Outlet />
  </QueryClientProvider>;
}

function RootError() {
  const error = useRouteError();
  return <main id="main-content" className="message-page"><h1>We could not open this view</h1><p role="alert">{error instanceof Error ? error.message : "Unexpected local error"}</p><Link to="/dispatch">Return to Dispatch</Link></main>;
}

function NotFound() { return <main id="main-content" className="message-page"><h1>Page not found</h1><p>This local route is not part of the closed KavaRoutes catalog.</p><Link to="/dispatch">Open Dispatch</Link></main>; }

export const router = createBrowserRouter([{
  path: "/", element: <AppShell />, errorElement: <RootError />, children: [
    { index: true, loader: () => redirect("/dispatch") },
    { path: "dispatch", lazy: () => privateCloud ? import("./routes/cloud-dispatch-route") : import("./routes/dispatch-route") },
    { path: "facility", lazy: () => privateCloud ? import("./routes/cloud-facility-route") : import("./routes/facility-route") },
    { path: "forbidden", lazy: () => import("./routes/forbidden-route") },
    { path: "session-expired", lazy: () => import("./routes/session-expired-route") },
    { path: "*", element: <NotFound /> },
  ],
}]);
