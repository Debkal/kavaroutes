# Business identity migration — 2026-09-29

The legacy Dispatch identity was a shared `Synthetic principal_dispatcher` header, a fixed TestPony tenant, and browser-selected billing/reviewer personas. Cloudflare admission was its outer gate. These headers no longer authenticate the deployed business runtime.

Ordinary businesses use email/password, Google, or Microsoft through the existing dedicated Firebase business tenant design. Login exchanges a freshly verified provider token for a persisted, host-only HttpOnly browser session. The server requires an explicit issuer/subject binding, active application user, business membership, and persisted scope/capability grants. Email alone cannot create or link a membership. Driver identities cannot acquire a business workspace through this flow. Unsafe requests require same-origin CSRF protection; cookies are restored without extending their expiry. Membership revocation is rechecked in PostgreSQL on every request. Provider account checks share in-flight work and a bounded 30-second cache, with a five-second deadline; unavailable evidence fails closed.

TestPony is the explicit exception for the current test environment. Its existing Cloudflare gate is retained, with signature, issuer, application audience, expiry, and verified subject validation at the origin. Only the configured test business and its explicitly provisioned owner may use that exception. Passing Cloudflare for any other business does not authorize business access. This is not the subscriber login provider.

The VM's Firebase business settings are not configured, as confirmed by the user. `/sign-in` therefore explains that business sign-in is being prepared; it does not fall back to a synthetic user or a shared password. Subscriber sign-in cannot be claimed live until those settings and explicit memberships are provisioned. The current Cloudflare Access application remains a test-environment ingress gate; subscriber production ingress must be configured independently when launched.

## Preserved data and Driver behavior

TestPony keeps its existing opaque business/tenant UUID, trips, routes, logs, driver credentials, and durable device sessions. Historical actor UUIDs and completed command receipts remain historical records; they are not credentials. No trip data or audit evidence is deleted or rewritten. Existing DriverSession tokens retain their format, credential-version revocation, persistence file, and 36-hour lifetime. They resolve as `DRIVER_DEVICE`, not a synthetic device. The Driver business/device gate and native background GPS path remain independent of business browser sign-in.

Dispatch API factories, command recovery, cache keys, map matching, live subscriptions, and driver setup links now use the authenticated business context. The browser cannot select a separate billing or reviewer identity; those actions require grants on the signed-in membership. Shared membership permission construction removes duplicate mapping logic. Maintained synthetic transports remain for explicitly opted-in isolated tests only. Archived pre-migration sources are hash-preserved beneath `archive/`.

The existing signing material is retained under the `migrated-live` compatibility secret profile so old strong ETags and server-held receipts remain interpretable. Its historical text prefix does not authenticate a user. Live realtime cursor construction requires explicit random material and does not use the fixture default key.

Admin provider usage forwards its already-verified owner's signed Access assertion to the loopback API. The separate admin audience can authorize only the internal metrics route, and still requires an explicit membership in the linked business. The app and Driver gateways do not expose that route. Existing admin MFA/session and owner checks remain required.

## Provisioning and deployment

`infra/gcp/runtime/provision-business-identity.mjs` is an offline operator command for an existing runtime business. Supply its protected administrator configuration, business UUID, **provider-verified** issuer/subject, display name, and `OWNER` or `DISPATCHER`. It writes explicit memberships and grants; it cannot promote a Driver membership. Downgrading to Dispatcher removes elevated grants. Tenant creation and worker enrollment remain separate administrative provisioning steps; arbitrary signup tokens do not create transport data or memberships.

`business-identity.json` is a protected VM secret file containing the session signing key, optional test-only Access configuration, optional admin metrics audience, and Firebase business client settings. The Firebase tenant must match the homepage's dedicated business tenant. Do not put provider tokens, passwords, or this signing key into source control. The client receives only public Firebase client settings when ordinary business authentication is enabled.

Image promotion now supports a closed optional file manifest. Protected API/worker/admin configurations and mounted gateway/Driver session adapters are backed up and restored with the image. Failed database attempts remain preserved. Static Dispatch and Driver bundles also retain rollback copies. The worker now marks a failed cycle unhealthy immediately instead of briefly advertising its prior success.

## Validation

- 132 web tests and both production web builds; shipped bundles reject legacy persona markers and harness fixtures.
- 36 Admin tests, including signed-assertion forwarding and owner-only metrics access.
- 30 root checks/tests plus governance, architecture, safe logging, dependency assurance, and contract lint.
- Business identity, persisted cookie/CSRF, tenant isolation, role grants, revocation, Driver credentials, GPS paths, command recovery, outbox delivery, and database outage behavior against disposable PostgreSQL/PostGIS.
- Explicit JWT signature/issuer/audience/expiry tests, pooled provider lookup/deadline tests, and deployment configuration rollback checks.

These checks do not claim ordinary subscriber SSO is configured, a physical-phone GPS run occurred during this migration, or a new native APK was distributed. Native application bytes are unchanged; the dedicated hosted Driver web bundle is updated.

## Deployed VM evidence

The existing VM now runs label `businessidentity20260929` with pinned runtime image `sha256:013ec93f72fae797ff957173d9d5f159fc2a11d3b3ba0f20961cf316908e723a`. Its previous image is `sha256:94bd13aaf24239059c44fa2163948fd3300e84fbdf88089103c194518d43ac22`. Database backup: `/opt/kavaroutes/backups/businessidentity20260929-before.dump`; protected file backups: `/opt/kavaroutes/backups/businessidentity20260929-files/`. Static rollback bundles are `/opt/kavaroutes/web/dist.pre-businessidentity20260929` and `dist-driver.pre-businessidentity20260929`. Admin source and health-monitor backups carry `.pre-businessidentity20260929` suffixes.

The existing verified TestPony owner subject has an explicit active membership. The Admin audit records `BUSINESS_IDENTITY_MIGRATED` against the preserved business UUID. Live loopback checks confirmed healthy API/worker, rejection of unauthenticated, forged Access, and legacy shared-persona requests, disabled ordinary provider sign-in, availability of Dispatch/history bundles, and the Driver business gate. Joel's authorized existing login returned a real Driver session and today's itinerary; only this smoke-test session was signed out. Existing Driver sessions were retained. VM health monitoring recognizes the new profile and both readiness endpoints.

Owner sign-in through a real Cloudflare browser session still needs the owner's browser to confirm; these checks did not impersonate that owner. Ordinary subscriber provider setup remains pending.
