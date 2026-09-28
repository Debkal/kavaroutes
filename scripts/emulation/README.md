# Android 35 emulator for KavaRoutes Driver

The SDK and `KR_API_35` virtual device live in `/home/chewy/emulation`. The `chewy` account has been added to the KVM group. Open a new login shell to pick up that group; until then, run the launcher with `sg kvm -c '~/emulation/android35.sh start'`. The launcher selects KVM automatically when `/dev/kvm` is accessible.

Run a headless installation and launch smoke test, saving logs and a screenshot under `~/emulation`:

```bash
~/emulation/android35.sh smoke
```

To keep the emulator running for interactive ADB work, run this in a WSL terminal and leave that terminal open:

```bash
~/emulation/android35.sh start
```

After boot, the first terminal accepts ADB arguments directly: type `shell getprop ro.build.version.sdk` to print `35`, `screenshot` to save the current screen, or `quit` to stop. A second WSL terminal can also use `~/emulation/sdk/platform-tools/adb -s emulator-5554` followed by an ADB command.

The smoke test checks boot, installs the current Driver APK, launches the app, checks that its process remains alive, and records an Android log and screenshot. The authenticated test was performed separately using a temporary business access code and the test driver account; those credentials are not stored in this repository.

API 35 validation of v0.1.7: business access and driver sign-in reached the vehicle precheck; foreground and background location prompts appeared; an active shift posted the ongoing Android notification; the foreground service and notification remained while the Home screen was open; turning off the phone Location switch blocked the Driver screen and its button opened Android Location settings; returning with Location on restored the screen. Reopening after a stopped process restarted the foreground service. The clean-install smoke test returned to the business access gate without a crash. Emulator GPS uploads still showed “Updates delayed”; verify actual upload freshness with a real phone before relying on this as a trip trace.

The launcher detects access to `/dev/kvm` and selects KVM automatically.

Google's [emulator command-line documentation](https://developer.android.com/studio/run/emulator-commandline) documents `-accel off` and the other launch flags. [Hardware acceleration documentation](https://developer.android.com/studio/run/emulator-acceleration) explains that Linux acceleration uses KVM.
