# HHereditas Android viewer

Read-only viewer for Android built on the shared `core`, `ui` and `viewer` packages.
It is a separate workspace from `apps/desktop`; the desktop app is not touched.

## Commands (from the repository root)

```sh
source apps/android-viewer/android-env.sh        # JAVA_HOME, ANDROID_HOME, NDK_HOME, GRADLE_OPTS
npm run dev -w @hhereditas/android-viewer        # browser dev server, port 1430
npm run android:build -w @hhereditas/android-viewer -- --debug --target aarch64   # debug APK, arm64 only
npm run android:build -w @hhereditas/android-viewer                               # release APK, all ABIs
npm run android:dev -w @hhereditas/android-viewer                                 # run on a connected device
```

The APK lands in `src-tauri/gen/android/app/build/outputs/apk/`. Install it with
`adb install -r <apk>`; the debug build is unsigned-for-store and uses the id `com.hhereditas.viewer.debug`.

## Toolchain

JDK 17 in `~/Android/jdk-17`, SDK in `~/Android/Sdk` (platform 35, build-tools 35.0.0, NDK 27.2.12479018),
Rust targets `aarch64/armv7/i686/x86_64-linux-android`. `src-tauri/gen/android` was created once with
`tauri android init` and is committed.

## WSL notes

This machine runs WSL in `virtioproxy` networking mode (`wslinfo --networking-mode`), where loopback TCP is
unreliable: a freshly bound port refuses connections for about two seconds and some listeners (the Tauri CLI's
options server, the Gradle and Kotlin daemons) are never reachable. Three workarounds keep the build working:

- `gen/android/gradle.properties`: `org.gradle.daemon=false`, `kotlin.compiler.execution.strategy=in-process`,
  and `org.gradle.jvmargs` matching the launcher JVM (`-Xms64m`, module opens) so Gradle runs in-process.
- `android-env.sh`: `GRADLE_OPTS` with the same JVM flags and `-Dorg.gradle.internal.instrumentation.agent=false`.
- `gen/android/buildSrc/.../BuildTask.kt`: when the Tauri CLI cannot be reached, the Rust task uses the library the
  CLI already built into `jniLibs` instead of failing.

Switching WSL to NAT networking (`networkingMode=NAT` in `%UserProfile%\.wslconfig`, then `wsl --shutdown`) should
make all of this unnecessary; the workarounds are harmless in that case.
