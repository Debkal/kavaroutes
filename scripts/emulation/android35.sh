#!/usr/bin/env bash
set -Eeuo pipefail

base=/home/chewy/emulation
sdk="$base/sdk"
adb="$sdk/platform-tools/adb"
emulator="$sdk/emulator/emulator"
apk=${2:-/home/chewy/kavaroutes/artifacts/mobile-builds/kararoutes_driverv017.apk}
mode=${1:-smoke}
export ANDROID_HOME="$sdk" ANDROID_SDK_ROOT="$sdk" ANDROID_AVD_HOME="$base/avd"
export ANDROID_USER_HOME="$base/android-user" ANDROID_EMULATOR_HOME="$base/android-user"
export QT_QPA_PLATFORM=offscreen
mkdir -p "$base/logs" "$base/screenshots" "$base/android-user"
chmod 700 "$base/logs" "$base/screenshots" "$base/android-user"

if [[ ! -x $adb || ! -x $emulator || ! -f $base/avd/KR_API_35.ini ]]; then
  echo 'Android 35 emulator installation is incomplete.' >&2
  exit 1
fi
if [[ $mode != smoke && $mode != start ]]; then
  echo 'Usage: android35.sh [smoke|start] [driver.apk]' >&2
  exit 2
fi
if [[ $mode == smoke && ! -f $apk ]]; then
  echo "APK not found: $apk" >&2
  exit 2
fi

adb_pid=
if ! ss -ltn 'sport = :5037' | grep -q LISTEN; then
  "$adb" -P 5037 nodaemon server >"$base/logs/adb.log" 2>&1 &
  adb_pid=$!
  sleep 2
  if ! kill -0 "$adb_pid" 2>/dev/null; then
    echo 'ADB server did not start; inspect logs/adb.log.' >&2
    exit 1
  fi
fi
accel=off
if [[ -r /dev/kvm && -w /dev/kvm ]]; then accel=on; fi
"$emulator" @KR_API_35 -no-window -gpu swiftshader -accel "$accel" -no-audio -no-boot-anim -no-snapshot -port 5554 -memory 2048 -cores 2 >"$base/logs/emulator.log" 2>&1 &
emulator_pid=$!
cleanup() {
  "$adb" -P 5037 -s emulator-5554 emu kill >/dev/null 2>&1 || true
  kill "$emulator_pid" 2>/dev/null || true
  wait "$emulator_pid" 2>/dev/null || true
  if [[ -n $adb_pid ]]; then kill "$adb_pid" 2>/dev/null || true; wait "$adb_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

echo "Android 35 emulator starting with acceleration $accel (emulator PID $emulator_pid; ADB PID ${adb_pid:-existing})."
echo "Logs: $base/logs/emulator.log"

booted=0
for attempt in $(seq 1 180); do
  if ! kill -0 "$emulator_pid" 2>/dev/null; then
    echo 'Emulator exited before boot; inspect logs/emulator.log.' >&2
    exit 1
  fi
  system_boot=$(timeout 8 "$adb" -P 5037 -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
  device_boot=$(timeout 8 "$adb" -P 5037 -s emulator-5554 shell getprop dev.bootcomplete 2>/dev/null | tr -d '\r' || true)
  if [[ $system_boot == 1 || $device_boot == 1 ]]; then
    booted=1
    break
  fi
  if (( attempt % 6 == 0 )); then echo "Waiting for Android boot: $((attempt * 5)) seconds"; fi
  sleep 5
done
if (( booted != 1 )); then
  echo 'Android 35 did not finish booting within 15 minutes; inspect logs/emulator.log.' >&2
  exit 1
fi

echo "Booted Android API $("$adb" -P 5037 -s emulator-5554 shell getprop ro.build.version.sdk | tr -d '\r')."
if [[ $mode == start ]]; then
  echo 'Emulator ready. Enter ADB arguments, screenshot, or quit. Another WSL terminal can also use adb -s emulator-5554.'
  while IFS= read -r command; do
    if [[ $command == quit ]]; then break; fi
    if [[ $command == screenshot ]]; then
      "$adb" -P 5037 -s emulator-5554 exec-out screencap -p >"$base/screenshots/current.png"
      echo "Saved $base/screenshots/current.png"
      continue
    fi
    if [[ $command == logcat ]]; then
      "$adb" -P 5037 -s emulator-5554 logcat -d -v time -t 2500 >"$base/logs/current.log"
      echo "Saved $base/logs/current.log"
      continue
    fi
    read -r -a args <<<"$command"
    if (( ${#args[@]} )); then "$adb" -P 5037 -s emulator-5554 "${args[@]}"; fi
  done
  exit
fi

"$adb" -P 5037 -s emulator-5554 install -r "$apk"
"$adb" -P 5037 -s emulator-5554 logcat -c
"$adb" -P 5037 -s emulator-5554 shell am start -n com.kavaroutes.driver/.MainActivity
sleep 20
"$adb" -P 5037 -s emulator-5554 exec-out screencap -p >"$base/screenshots/driver-launch.png"
driver_pid=$("$adb" -P 5037 -s emulator-5554 shell pidof com.kavaroutes.driver | tr -d '\r')
if [[ ! $driver_pid =~ ^[0-9]+$ ]]; then
  echo 'Driver process is not running after launch; inspect logs/driver-launch.log.' >&2
  exit 1
fi
"$adb" -P 5037 -s emulator-5554 logcat -d -v time --pid="$driver_pid" >"$base/logs/driver-launch.log"
if rg -n 'FATAL EXCEPTION|Fatal signal' "$base/logs/driver-launch.log" >"$base/logs/crash-lines.txt"; then
  echo 'A crash was recorded; inspect logs/crash-lines.txt.' >&2
  exit 1
fi
echo "Driver launch stable. Screenshot: $base/screenshots/driver-launch.png"
