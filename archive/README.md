# Historical source archive

This tree preserves obsolete KavaRoutes source and completed one-off tools. It is excluded from npm workspaces, TypeScript project references, active CI suites, application Docker contexts, and deployed bundles. Active application code must not import it.

`manifest.json` records original paths, reasons, and SHA-256 hashes for the archived source snapshots. Run `npm run check:project-audit` to verify those originals and inspect the current source inventory. Historical planning notes are retained locally under `archive/stale/historical-notes`; they do not define current authorization or development rules.

The current Driver app is `apps/driver-native`; the dedicated web client remains `apps/web`. `archive/apps/driver` and `archive/packages/driver-core` are the retired Expo feasibility app and its supporting package. Original imports are deliberately preserved; these snapshots are historical evidence, not runnable standalone applications. To run an old version, restore a coherent historical Git revision in an isolated checkout.

Completed deployment patches and seed fixtures are retained for reference. Use the active parameterized runtime promotion and web-bundle deployment tools for current releases. Do not rerun historical seed scripts against a live business.

Generated Android/iOS trees and build caches moved with the old local app remain ignored and are never added to a release. Maintained browser acceptance fixtures remain under `apps/web/src/test-support`, separate from this archive, and are stripped from production builds by an explicit build flag.

The retired shared-identity gateway, Driver session fallback, and web transport are also preserved at their original paths under this archive. The corresponding live paths have been migrated to real identity/session handling; the archived snapshots never participate in live authentication.
