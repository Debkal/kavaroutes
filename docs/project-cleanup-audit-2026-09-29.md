# Project cleanup and request audit — 2026-09-29

The audit covers the repository's first-party application and package source, SQL, deployment tools, CI configuration, and tests. `scripts/project-audit.mjs` records the inventory, source categories, prototype/TODO marker locations, per-function decision counts, and archived-original hashes in `artifacts/project-audit/current.json`. This is a repository-wide static inventory plus dependency and request-path review, not a claim that every behavior has been exhaustively verified. Generated output, secrets, dependencies, and historical archive are excluded from active-code analysis.

## Archived and separated

- Retired `apps/driver` Expo feasibility application and `packages/driver-core`, including their original source, tests, and recorded artifacts.
- Three SOL-series Driver smoke clients that import that retired app; unused Driver/SOL seed and repair SQL; completed one-off Driver host/inspection/sign-out and manual-charge deployment patches; the completed test_pony manual-charge seed.
- Obsolete orchestration checker and its tests: they require missing historical planning files and hardcode pre-deployment milestones.
- Old cleanup reports and `stale/historical-notes`, now beneath the root `archive/` tree.
- The local decode-uri-component compatibility fork, dependency and override. Its only runtime caller belonged to the retired Expo Router app; current dependency-assurance tests no longer import the absent query-string package.

The archive preserves original paths and hashes. Its generated native build caches remain local and ignored. Historical ignored planning documents remain local; existing tracked source is preserved in Git.

Maintained browser test doubles are retained under `apps/web/src/test-support`. The live QueryClient no longer initializes fixture stores. Vite's explicit harness flag defaults to false and removes the fixture routes from production output. `check:web-bundles` verifies both Dispatch and dedicated Driver bundles for fixture leakage. Historical migrations and fixtures used by current integration tests remain active.

## Request and computation changes

| Path | Previous behavior | Current behavior |
| --- | --- | --- |
| Dispatch live updates | Two sockets on one page; redundant parent snapshot polling | One socket owned by the board; cached handshake snapshot shared with route review |
| Connected board | REST board every 5 seconds | Realtime invalidations plus 30-second safety refresh; disconnected fallback remains 5 seconds |
| Shift/route-review metadata | Separate snapshot/tracking cache keys and 5-second polls | Shared resource keys and 30-second metadata polls; proposal detail checks every 15 seconds |
| Empty command recovery | Poll every 2 seconds indefinitely | Poll every 30 seconds when idle/resolved; pending commands retain 2-second polling; manual refresh remains |
| Return review | Poll every 5 seconds, including ended shifts | 15 seconds while active; polling stops after confirmed shift end |
| Live tracking screen | Custom interval continues in hidden tabs and bypasses the shared cache | Shared QueryClient tracking resource; 10-second visible status refresh retained, background interval disabled by default |
| History and map trace | Empty-string versus null client filter yields two cache entries | One normalized date/shift/client key, shared in-flight request, 60-second freshness window |
| Empty history refresh | Calls full-trace function without a selected shift | Refreshes day data only until a shift exists |
| Tracking database read | One shift query plus one trace query for each of up to 200 shifts | Two data queries total; per-shift LATERAL read limited to 500 points, grouped in one pass |
| History event lookup | Repeated event/run/leg scans while rendering each row | Memoized bottom-up shift, run, leg and first-applied-action indexes |
| Map computation | Rebuilds selected trace arrays and Google Maps export URL on unrelated renders | Memoized stable trace/filter and URL computations; existing Leaflet state and authorized tile batching retained |
| Dispatch refusal text | Repeated switch branches for fixed code-to-message mappings | One Map lookup; unknown codes still return null |

With the default Dispatch page visible, a live socket and no selected proposal or incoming changes, configured recurring metadata reads fall from approximately 48 to 6 per minute. This is a scheduling estimate, not measured production traffic; actual counts include events, failures, initial loads and manual refreshes. Native GPS sampling/upload cadence, map panning/zooming, road-matching, leg colors, distances, client filters, CSV/KML exports, and third-party usage logging are preserved.

## Build and evidence repairs

Root Driver commands and CI now target `apps/driver-native`, not the archived prototype. The Driver test lane covers the native origin bridge, versioned APK delivery and current web controls. CI builds/packages both `dist` and `dist-driver`, runs the archive-boundary inventory and checks production bundles. Archived-only paths do not trigger live component suites. Docker build contexts and payload checks exclude the archive and retired Driver package.

The pruned lockfile has 982 entries versus 1,372 previously. A fresh install exposed Vitest's optional jsdom peer not resolving from its hoisted location; its pinned browser environment is now explicitly provided by the root test workspace. Native and app versions remain unchanged.

Dependency evidence now runs its own fresh registry scan instead of accepting a caller-supplied “verified” flag. The SBOM includes all resolved lockfile components even on a partially installed machine. The separate inventory command no longer asserts a historical clean advisory scan. The new registry scan identified Undici advisories; the existing 8.x test dependency is pinned to patched 8.10.2, supported by [the upstream advisory](https://github.com/nodejs/undici/security/advisories/GHSA-w293-vg96-wgc3). The final scan reports zero known advisories and inventories 895 unique components. Native-addon inspection remains explicitly limited to installed-tree indicators; it is not a substitute for platform testing.

## Verification

- Fresh isolated npm install; root checks and tests: 30 passed, plus 27 governance checks.
- Web: 37 files / 130 tests passed, including caching/request counts, realtime fallback, map controls, leg/client filtering, exports and empty-history refresh.
- Admin: 36 tests passed. Public site: 8 tests passed. Both apps build successfully.
- API/runtime/identity/location unit suites: 101 passed, 3 explicitly skipped integration cases; disposable PostgreSQL runtime integration passed separately, including the actual tracking endpoint and empty traces.
- Current native Driver typecheck, bridge/APK delivery tests, public config and Android/iOS bundle exports passed. No native bytes changed and no new APK is distributed.
- Runtime promotion/push/rollback/health helper drills: 29 passed.
- Exact runtime image inspected as non-root, matched to 205 source files, and inventoried with no archive or retired client package. Dispatch and Driver production bundles passed fixture-exclusion checks.

## Remaining boundaries

The currently deployed Dispatch composition still relies on the legacy private-synthetic/test_pony principal and fixed tenant contracts. The independent Driver authentication path uses real business/device/driver credentials. Removing those active Dispatch identity contracts requires a coordinated authenticated multi-business migration; deleting or cosmetically renaming them would break current data and authorization. Accordingly, `prototype-web-gateway.mjs` and the existing VM overlay retain their compatibility names because they remain live deployment dependencies.

The worker's single-job fetch remains intentional: its leased jobs must not expire while earlier jobs execute. Existing pool bounds, one in-flight cycle, bounded outbox claims and enrollment checks remain. High-branching safety, tenant, role, policy and command-version validation stays explicit. Decision counts flag areas for review; reducing that number alone is not a correctness improvement.

This cleanup does not certify production PHI readiness or replace physical-phone background-GPS tests. The shared local node_modules tree has incomplete/stale packages; verification used a fresh temporary checkout instead of destructively replacing that tree. Existing unrelated responses, admin lockfile and local capacity artifacts were preserved.

## Deployment

Promoted runtime label `projectaudit20260929` to the existing VM and deployed both Dispatch and gated Driver web bundles. Exact image: `sha256:94bd13aaf24239059c44fa2163948fd3300e84fbdf88089103c194518d43ac22`. Previous runtime: `sha256:aad63fbf036e4ef5c37d7b0da7910526053f537dee1eccc41fea8a43ad3b65a0`.

Rollback evidence: `/opt/kavaroutes/backups/projectaudit20260929-before.dump`, `/opt/kavaroutes/runtime/vm.env.pre-projectaudit20260929`, `/opt/kavaroutes/web/dist.pre-projectaudit20260929`, and `/opt/kavaroutes/web/dist-driver.pre-projectaudit20260929`. Migration head remains `0050_external_api_request_log.sql`; no schema change was needed. Promotion and both atomic web-bundle smoke checks passed. No Git push was performed.
