# WP010 revised Android test runbook

## Scope and current decision

This is the revised local synthetic Driver candidate, not the production KavaRoutes Driver product. The old menu-style APK is obsolete. This build joins the feasibility surfaces into one shift: start, vehicle confirmation, precheck, grouped itinerary, rider evidence, return, postcheck, end odometer, signoff, and shift end.

The local Expo/React Native gate passes, but no automated check can prove physical-device behavior. WP010 therefore remains `BLOCKED_PENDING_HIG_006`. Android needs the device protocol below. iOS development remains deferred until a macOS/Xcode test host is ready; the existing Hermes bundle is preserved but is not installable.

Use only made-up, non-PHI information. When testing the camera, photograph a plain made-up object only—never a person, paper/document, label, screen, address, vehicle record, or anything identifying. This build has no production account/server and cannot establish production acceptance, background reliability, battery feasibility, store readiness, or PHI readiness.

## Prepared artifacts

- Android APK: `builds/client/android/kavaroutes-driver-android.apk`
- Package: `com.kavaroutes.driver.synthetic`
- Android range: minimum API 29/Android 10; target API 36
- Size: 179,056,025 bytes
- SHA-256: `5fb3b3fd901aaab0ec1c65b5a7e4fb79f005890da38d3409ccd9ba667aad9709`
- Source digest: `2e265e6fcb841b94c818b26e01c985a87719d3d98ed9f0d3428b18ddfff72203`
- Signing: generated Android debug certificate, release-mode/non-debuggable; not production-signed or store-ready
- iOS Hermes bundle: `builds/client/ios/kavaroutes-driver-ios-hermes.hbc`
- iOS SHA-256: `c7fb226ff832c5498fb98cb97d8fbd660db5f05e8eb9927aba29af132a6f0aa0`
- iOS status: `DEFERRED_PENDING_MACOS_XCODE`; the `.hbc` file cannot be installed

Rebuild Android with `npm run kavaroutes:android`. Keep `npm run build` for the normal repository TypeScript build. Do not advance `npm run kavaroutes:ios:prepare` until the human resumes iOS on macOS/Xcode.

## Android installation

Connect the approved Android device with USB debugging or Android 11+ wireless debugging. WSL USB requires attaching the device to WSL from Windows first; wireless ADB usually avoids that bridge. Do not record device serials, account identifiers, pairing secrets, or signing secrets in Builder files.

From `/home/chewy/kavaroutes`:

```sh
sha256sum builds/client/android/kavaroutes-driver-android.apk
.tooling/android-sdk/platform-tools/adb devices -l
.tooling/android-sdk/platform-tools/adb install -r builds/client/android/kavaroutes-driver-android.apk
```

The checksum must exactly match the value above. The APK can also be transferred and installed directly. Record only manufacturer, model, Android version/API, ownership, battery condition, and test role.

## Connected-shift walkthrough

Run this once from a clean reset, then repeat the relevant steps after process death/relaunch. Record every unexpected no-op, wrong screen, missing status, duplicate action, stale status, crash, or unrecoverable state.

1. Reset the app's test data before starting so the server issues the new Small Business owner-operator assignment. Open **My shift**, read the synthetic-test notice, and start the shift. Exercise denied permission, approximate permission, and accepted foreground/background permission paths. Confirm the screen visibly shows pending then accepted or failed; it must not silently start.
2. Use **Confirm van and start route**. Confirm the route opens without forcing the optional 20-item inspection or odometer. Reset and repeat using **Do the optional vehicle check**; verify blank, decimal, negative, and greater-than-9,999,999 odometer values are rejected, then enter a valid integer.
3. In the optional check, exercise no defect, not applicable, and defect found. A defect must require severity plus a note and safe test photo or a closed exception. Use an Enterprise test assignment later when an authorized server fixture is available to physically confirm required controls and critical-defect blocking; automated coverage already retains those paths.
4. Complete the grouped itinerary in order: P1, P2, D1, D2. At each node, press **Open directions** and confirm Android opens Google Maps to that demo coordinate. Return to KavaRoutes, press the single **Confirm pickup** or **Confirm drop-off** button, and confirm the next screen is the signature. Choose **Rider signs** or **Driver signs**, draw the mark, then use **Queue signature and continue route**. Confirm the next rider appears immediately and exactly once; after D2, confirm return appears. A previous signature must never auto-fill another step.
5. Exercise a stop exception. Confirm it alerts but does not mark the stop complete. While safely traveling as a passenger/tester, confirm accurate native speed of at least 2 m/s marks the vehicle moving and blocks confirmation/signature/route tools. After stopping, confirm the app unlocks after three accurate stationary readings without any manual parked button. Do not perform this interaction while operating the vehicle.
6. Open **Change the stop order** and exercise the Small Business owner-operator flow plus representative invalid choices. A change must never violate pickup-before-drop-off, onboard-rider, time-window, capacity, equipment, or qualification rules. Enterprise dispatch approval remains an automated/server-fixture lane until an authorized Enterprise physical assignment is available.
7. Return to base. Confirm the optional Small Business post-trip check can be completed or explicitly skipped without being called completed. Exercise a valid current-location evaluation, advisory exception, emergency stop, signoff, and shift end. Required Enterprise override behavior remains an automated/server-fixture lane until an authorized Enterprise physical assignment is available.
8. Exercise manual sync while online and offline. Confirm pending, accepted, failure, and conflict remain distinct. Synthetic acceptance may update encrypted local state, but the app must never describe a production-server result.
9. Open diagnostics, confirm no location/manifest/PHI values are displayed, perform the confirmed reset/wipe, and relaunch. Confirm the old workflow and evidence are not restored after a completed wipe.

Also press primary actions twice quickly while they are busy. Only one action should execute, and the visible state should explain what is happening. Any enabled-looking button that does nothing reopens the dead-control defect.

## Lifecycle and platform protocol

On each approved Android device, repeat appropriate workflow steps while foregrounded, backgrounded, locked, screen-off, app-terminated/force-stopped, rebooted, offline/poor-network, battery saver/Doze/OEM-restricted, and after foreground/background location permission is denied, revoked, or made approximate. Verify navigation handoff and return, encrypted checkpoint recovery, camera/signature recovery, database/key wipe, and TalkBack ordering/names/hints.

Run one continuous eight-hour synthetic shift per required device. Record requested and delivered intervals, p50/p95 freshness, accuracy distribution, gaps/duplicates, queue/database growth, sync convergence, CPU/memory/UI stalls, wakeups/bytes, heat/thermal state, and battery percentage/hour against a matched no-tracking baseline. The selected profile passes only if moving freshness p95 is at most 15 seconds, stale marking is at most 60 seconds, and attributable battery is at most 2 percentage points/hour on every required device. A failure cannot be averaged away.

Required Android coverage is a current stock/near-stock device, a common aggressive-background OEM device, and the oldest available Android 10+ device; one device may fill multiple slots if documented. Eventual iOS completion still requires the approved iPhone/oldest iOS 16.4+ coverage and VoiceOver after iOS resumes.

## Local verification record

`npm run kavaroutes:driver:verify` passed on 2026-08-28:

- strict TypeScript build and architecture/privacy lint across 56 source files and nine route surfaces;
- 17 Driver core/workflow tests and five React Native interaction/accessibility/policy tests;
- Expo public configuration and Expo Doctor `21/21`;
- two deterministic CNG generations over 26 files, digest `7d7eebf5cbff503b88ce8d61634e09afa2df24c10f88743174d68070e6ceefaa`;
- Android Hermes bundle, 3,712,205 bytes across 1,705 modules;
- 12-hour/2,880-sample offline fixture in six bounded batches;
- 25 exact direct dependencies and zero npm audit vulnerabilities;
- platform, WP007, and WP009 regression suites.

The stable local feasibility digest is `1fad69efb93eb4c2dcc8df2db2fdb082dba5b4a29be6d48626f45b3218e83fdc`. Exact Thinker-approved Expo/React Native versions remain pinned; Expo Doctor's automatic patch-version suggestions are explicitly excluded for those pins, and Doctor passes `21/21`.

## Storage and recovery boundary

The native seam uses `expo-sqlite` with SQLCipher plus `expo-secure-store` for the 256-bit database key and installation-generation reference. Two local migrations cover the operational store and encrypted workflow checkpoint. The adapter applies the key before schema access, requires cipher/integrity checks, binds installation/session generation, migrates transactionally, persists checkpoints and cursors atomically, quarantines mismatched binding, and supports database-plus-key wipe.

Camera bytes are copied into encrypted evidence storage and the temporary camera file is deleted. Location sequence recovery hydrates the highest stored sequence after restart so new samples are not incorrectly discarded as duplicates. Physical testing remains authoritative for native lock/reinstall, wrong-key/corruption, storage-full, process death, background delivery, and wipe behavior.

## HIG-006 boundary and cleanup

Android ADB/install/reset/reboot/force-stop, permission/settings changes, battery/background restrictions, accessibility trials, and the eight-hour synthetic run are approved. No Play Console is needed. iOS, remote builds/device services, EAS, developer enrollment, paid services, production signing, store distribution, source upload, public servers, Maps SDK/API calls, push, real driver tracking, PHI, or customer access remain outside this runbook unless separately reviewed.

After testing: stop tracking; sync or explicitly quarantine pending synthetic work; wipe the local database/key; uninstall the app; remove debug pairing and permissions; delete local test photos/transfers and unneeded development artifacts; and record exceptions without secrets or device identifiers.
