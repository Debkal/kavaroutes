# Driver production audit — 2026-09-29

Scope: the deployed `apps/driver-native` shell, dedicated Driver web bundle, business/device gate, Driver credentials and sessions, GPS ingestion, and supporting Dispatch tracking reads. Historical `apps/driver` feasibility code is a separate application and must not be distributed as the current Driver app.

## Repaired and verified

- SQLCipher queue operations used Expo exclusive transactions, which open a second unkeyed connection. All GPS inserts, batch claims, and receipt cleanup now use the keyed connection. An Android 35 release test exercised these actual operations and displayed `QUEUE_PROBE_OK`; its temporary probe was removed before packaging v0.2.1.
- The offline queue held 240 samples, approximately one hour at the actual 15-second sampling interval. It now holds 5,760 unclaimed fixes (approximately 24 hours); claimed batches remain available for idempotent retry. GPS uploads remain batched at roughly one per minute.
- The server rejected buffered samples older than 30 minutes. It now accepts samples up to 24 hours old from the current active shift, retaining the pre-shift and future-clock bounds. Mixed accepted/rejected batches and replay preserve their outcomes; rejected fixes are visible in Driver status.
- Removed the web adapter's default test business identifier. The Driver page requires the business context supplied by the access gate.
- Removed the gateway's compatibility exception for Driver tokens without an enrolled business device. An unbound or revoked token is refused. The business gate and access-management tests cover enrollment, revocation, rotation, and unknown tokens.
- APK builds sync generated Android version fields from `app.json`, verify release metadata, and archive/deliver the same bytes under the versioned filename.
- Updated vulnerable Fastify transitive `fast-uri` versions to patched 3.1.7 and 4.1.4. The clean runtime image install and audit reported zero vulnerabilities.
- Expired password lockouts previously retained `LOCKED` status indefinitely. Timed locks now expire, reset the failed-attempt count, and permit password verification; administrative locks without an expiry stay locked.
- Driver requests without a session no longer allocate an orphan timeout and abort listener before rejecting.

## Deployment and evidence

v0.2.1 / Android versionCode 12: `artifacts/mobile-builds/kararoutes_driverv021.apk`, copied to `~/lanftp-received/kararoutes_driverv021.apk`.

SHA-256: `05c0e1d319b393fd2b8034736cf4277b46906c81c918ebb45b5b5f94d5433534`.

The final APK passed an Android 35 install/launch test. That test verifies launch and queue storage; it does not prove GPS delivery on a physical phone while Maps is foregrounded. Previous ride fixes that failed before insertion cannot be reconstructed.

Final runtime promotion `driveraudit20260929` installed image digest `sha256:aad63fbf036e4ef5c37d7b0da7910526053f537dee1eccc41fea8a43ad3b65a0`; backup `/opt/kavaroutes/backups/driveraudit20260929-before.dump`. The Driver web bundle was also deployed atomically. API, worker, and gateway were verified healthy on the expected digest; `KR_CLOUD_LOCAL_TEST` was disabled; the business page gate and unknown Driver-token denial passed. The previous runtime image remains available for rollback.

Validation: repository TypeScript build; 13 GPS/session/gateway/APK regression tests; 12 transport tests; 12 Driver web/origin/login/native-bridge tests. The clean runtime image compiled and audited with zero reported dependency vulnerabilities. These checks do not replace physical-phone background GPS acceptance.

## Remaining production work

These are actual code limitations, not a production certification:

- The shared runtime still declares `private-synthetic`, refuses `NODE_ENV=production`, and uses synthetic provider/dispatch principals. Driver login itself uses real business-scoped credentials and hashed sessions, but a full production runtime composition needs an identity migration and must preserve tenant isolation. Renaming these contracts would not fix their behavior.
- Driver inspection and attestation contracts still carry versioned names such as `inspection-synthetic-v2`; they must be migrated compatibly with stored policies and receipts rather than renamed in place.
- Native network fetches currently have no app-defined abort deadline. A stalled request can hold the single uploader or native command until the platform ends it.
- Native STOP clears local queued fixes. Sign-out, emergency stop, or shift closure while offline can lose unsent trace points. Preserving stopped-shift uploads requires a coordinated server contract and encrypted queue ownership by shift; it must never send old fixes as a new shift.
- Foreground/background mutation paths need an explicit lifecycle lock to protect against shift start/stop racing with an outstanding upload. The current single upload promise pools upload calls within one JavaScript runtime but is not a cross-process lease.
- The phone can report a healthy foreground service while GPS delivery fails. Dispatch already persists freshness alert transitions from actual received fixes; the native notification currently describes service activity and does not dynamically show upload receipt status.
- Phone location-service/permission interruptions and server freshness alerts are observable, but sanitized native stage failures are displayed locally rather than sent as distinct diagnostic events to the admin catalog.
- Driver sessions last 36 hours and business device enrollment lasts 30 days. Password change/device revocation ends access deliberately. Renewal during a long shift and reboot/force-stop recovery need physical-device evidence.
- Production Android signing and iOS archive/device testing remain separate release requirements. Current emulator evidence cannot establish OEM battery behavior or iPhone background reliability.

## Physical-phone acceptance

Install v0.2.1 over the current app while safely parked. Keep app data. Sign in, start an assigned shift, confirm a real server GPS batch receipt, then open Google Maps and lock the phone. Confirm fresh coordinates and a matching breadcrumb trace arrive for that same driver/business. Test a brief network outage, restore connectivity, and confirm buffered samples replay once. Confirm deliberate sign-out stops location collection and device revocation denies further uploads. Never create simulated GPS data in a live shift to claim this test passed.
