# Project cleanup report

Date: 2026-09-18

## Safety point

Cleanup began only after creating local commit `15369b2` (`chore: checkpoint before project cleanup`). This is the pre-cleanup rollback point. The worktree was clean before that empty checkpoint commit was created.

## Completed cleanup

- Removed the unreachable private-cloud facility web slice:
  - `apps/web/src/cloud-facility-api.ts`
  - `apps/web/src/routes/cloud-facility-route.tsx`
  - its two self-referential test files
- Removed the dead facility factory from the deployed-origin transport test. The active `/clients` route, synthetic facility route, server facility contracts, and facility authorization behavior were not removed.
- Simplified the Driver web route's redundant backend conditional; both branches loaded the same private-cloud module.
- Removed ignored, reproducible browser/test output from `.playwright-mcp/`, `test-results/`, and `apps/web/test-results/` (about 8 MB at the time of cleanup).
- Removed the ignored write-probe file `.audit_write_probe.txt`.
- Preserved build capability and local build assets. In particular, `apps/driver/android`, `apps/driver/ios`, `apps/web`, `builds/`, `artifacts/mobile-builds/`, dependencies, SDKs, and local toolchains remain in place.
- Moved historical Markdown notes into `stale/historical-notes/`; none of those notes were deleted.

## Historical-note cleanup queue

`stale/historical-notes/` is a quarantine and review queue, not a deletion queue. It contains the former root-level builder, audit, cloud, Docker, VPS, web, QA, research, handoff, planning, and status notes, plus the old Codex cloud-audit prompt. These files contain useful chronology but many describe superseded revisions, deployed build IDs, resolved findings, or old worker procedures.

Before deleting any file from this queue:

1. Confirm that no unresolved decision, rollback instruction, operational dependency, or evidence reference exists only in that file.
2. Promote still-current operational instructions into a maintained document under `docs/` near the component they govern.
3. Promote enduring architecture decisions into a short, versioned decision record instead of retaining an ever-growing worker log.
4. Keep externally required audit evidence according to the applicable retention policy; do not infer a retention period from file age.
5. Delete or archive the reviewed historical copy only after an accountable owner records the decision.

The queue is intentionally local under the repository's existing `*.md` ignore policy. `clean_up.md` should be force-added if this report is intended to become tracked project documentation.

## Governance assessment

The `governance/privacy` directory is technically strong but was only partially effective before this cleanup.

What was already effective:

- Provider-neutral source catalogs separate classifications, policy, assurance evidence, and synthetic flow examples.
- Validation fails closed on unknown fields, missing evidence, cross-tenant access, sensitive egress, unresolved legal/vendor status, and misleading compliance claims.
- Generation is deterministic and produces `normalized/privacy-assurance-contract.json`.
- The governance package has focused negative tests and does not require network access or external services.
- `packages/api-contracts/scripts/lint-artifacts.mjs` reads the privacy policy registry, so part of the API-contract generation path already depends on governance data.

What was ineffective:

- The governance package was outside the root npm workspaces and absent from the root `npm test` path.
- CI did not execute its generator, validator, or tests and did not detect a stale normalized contract.
- Most application code does not consume the normalized assurance contract directly. The directory therefore acts primarily as design-time assurance, not a universal runtime policy engine.

Changes made here:

- Added `governance/*` to the root npm workspaces and recorded the privacy package in `package-lock.json`.
- Added a supported package entry point, `governance/privacy/index.mjs`, which loads and validates all four governance source registries and returns their deterministic normalized contract.
- Changed API artifact lint to consume that validated governance entry point instead of reaching directly into one raw JSON file. API contract lint therefore fails if any linked classification, policy, assurance, or flow source is invalid.
- Added root script `check:governance`, which runs the privacy package's deterministic generator, validator, and tests.
- Added `check:governance` to root `npm test`.
- Added governance verification to the CI boundary-check step and made CI fail if generation changes the committed normalized contract.

How governance should be used in the code tree:

- Treat the files under `catalog/`, `hipaa/`, and `flows/` as reviewed sources of truth; treat `normalized/` as generated output.
- Reference stable governance identifiers from API schemas and enforcement adapters rather than copying classification or purpose strings into apps.
- Keep enforcement at server/domain boundaries. Web and Android clients may display decisions but must not become the authority for tenant, purpose, retention, or regulated-data access.
- Require a catalog/flow update and governance test whenever a new sensitive field, destination, role, purpose, vendor, or data flow is introduced.
- Map every runtime enforcement control to an evidence owner and test in the assurance registry. Do not interpret a passing synthetic governance suite as legal approval or production-PHI readiness.
- Keep the normalized-artifact diff check in CI so reviewers can see the policy effect of source changes.

## Verification expectations

The cleanup is complete only when all of the following pass after the changes:

- root `npm test`
- web unit tests and production build
- Driver unit/UI tests and TypeScript/build checks used by its maintained verification scripts
- governance generation leaves its normalized artifact unchanged
- `git diff --check`

Large build/tool directories were not deleted merely to reduce disk use. They are retained because the request requires Android and web builds to remain maintainable and because regenerating local SDK/toolchain assets can be costly.

## Verification completed

- Root `npm test`: passed (32 project tests plus 27 governance tests).
- Web: 23 test files / 86 tests passed; production Vite build passed.
- Driver core: 2 tests passed.
- Driver UI: 19 suites / 70 tests passed.
- Expo public configuration: generated successfully.
- Deterministic Android/iOS native prebuild: passed across two clean temporary generations.
- Android Hermes export: passed and produced `apps/driver/dist/export`.
- Online dependency audit: zero vulnerabilities; lockfile-bound assurance evidence regenerated.
