# TODO: android-sdk Installer Package

## Why

`./gradlew build` on Android/KMP projects (e.g. WellnessWingman) fails with:
> SDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable.

The fix is a new `android-sdk` installer package, plus a small change to the install pipeline
so that earlier-installed tools (specifically `java-temurin`) are visible to later install steps.

## Prerequisite order for users

After this is implemented, users install in this order (repo scope):
1. `/install java-temurin` — provides `java` needed by sdkmanager
2. `/install android-sdk` — uses `java` from the accumulated scope env

---

## Step 1 — `src/services/installService.ts`

### Update `mergeInstallEnvironment` to accept accumulated scope env

```typescript
// Change signature from:
private mergeInstallEnvironment(envVars: Record<string, string>, pathEntries: string[]): NodeJS.ProcessEnv

// To:
private mergeInstallEnvironment(
  envVars: Record<string, string>,
  pathEntries: string[],
  priorEnv?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = priorEnv ?? { ...process.env };
  const env: NodeJS.ProcessEnv = { ...base, ...envVars };
  env.PATH = `${pathEntries.join(":")}:${base.PATH ?? ""}`;
  return env;
}
```

### Update `runInstall` to pass scope env into install steps (line ~145)

```typescript
// Replace:
const env = this.mergeInstallEnvironment(plan.envVars, [binDir]);

// With:
const scopeEnv = this.buildExecutionEnvironment({
  repoId: installRequest.repo_id,
  threadId: installRequest.thread_id
});
const env = this.mergeInstallEnvironment(plan.envVars, [binDir], scopeEnv.env);
```

`buildExecutionEnvironment` only returns `status = 'succeeded'` installs, so the currently
running install is never included.

---

## Step 2 — `src/services/installerRegistry.ts`

### Add `PYTHON_WRITE_LICENSE_FILES_SCRIPT` constant

Add before `PYTHON_DOWNLOAD_AND_EXTRACT_SCRIPT`. Writes well-known Android SDK license hashes
to `$ANDROID_HOME/licenses/` — avoids needing `yes |` piped into sdkmanager.

```typescript
const PYTHON_WRITE_LICENSE_FILES_SCRIPT = `
import os, sys
licenses_dir = sys.argv[1]
os.makedirs(licenses_dir, exist_ok=True)
for name, content in [
    ("android-sdk-license",
     "\\n24333f8a63b6825ea9c5514f83c2829b004d1fee\\nd56f5187479451eabf01fb78af6dfcb131a6481e\\n"),
    ("android-sdk-preview-license",
     "\\n84831b9409646a918e30573bab4c9c91346d8abd\\n"),
    ("intel-android-extra-license",
     "\\nd975f751698a77b662f1254ddbeed3901e976f5a\\n"),
]:
    with open(os.path.join(licenses_dir, name), "w") as f:
        f.write(content)
`.trim();
```

### Add `resolveAndroidCompileSdk` function

Add after `resolveKotlinVersion`. Reads the Android API level from config files, defaults to `"34"`.

```typescript
function resolveAndroidCompileSdk(repoRoot: string): string {
  const gradleProperties = readRepoFile(repoRoot, "gradle.properties");
  if (gradleProperties) {
    const configured = parseKeyValueFile(gradleProperties).get("actuarius.android.compileSdk");
    if (configured) {
      return requireMatchingVersion(
        configured,
        /^\d+$/,
        "`gradle.properties` key `actuarius.android.compileSdk` must be an integer like `34`."
      );
    }
  }

  const buildFiles = [
    "build.gradle.kts", "build.gradle",
    "androidApp/build.gradle.kts", "androidApp/build.gradle",
    "app/build.gradle.kts", "app/build.gradle"
  ];
  for (const buildFile of buildFiles) {
    const content = readRepoFile(repoRoot, buildFile);
    if (content) {
      const match = content.match(/compileSdk(?:Version)?\s*[=:]\s*(\d+)/);
      if (match?.[1]) return match[1];
    }
  }

  return "34";
}
```

### Add `getAndroidBuildToolsVersion` helper

```typescript
function getAndroidBuildToolsVersion(apiLevel: string): string {
  const level = parseInt(apiLevel, 10);
  if (level >= 35) return "35.0.0";
  if (level >= 34) return "34.0.0";
  if (level >= 33) return "33.0.3";
  return "32.0.0";
}
```

### Add `android-sdk` package to `packageDefinitions`

```typescript
{
  packageId: "android-sdk",
  summary:
    "Android SDK command-line tools, platform-tools, and the target platform. Requires java-temurin at repo scope.",
  supportedScopes: ["repo"],
  resolveVersion: resolveAndroidCompileSdk,
  buildPlan: (installRoot, packageVersion) => {
    const androidHome = join(installRoot, "home");
    const cmdlineToolsBin = join(androidHome, "cmdline-tools", "latest", "bin");
    const sdkmanagerBin = join(cmdlineToolsBin, "sdkmanager");

    return {
      packageId: "android-sdk",
      packageVersion,
      installRoot,
      envVars: {
        ANDROID_HOME: androidHome,
        ANDROID_SDK_ROOT: androidHome
      },
      steps: [
        makeDownloadAndExtractStep(
          "Download Android command-line tools",
          "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip",
          join(installRoot, "downloads", "cmdline-tools.zip"),
          join(androidHome, "cmdline-tools", "latest")
        ),
        {
          label: "Accept Android SDK licenses",
          command: "python3",
          args: ["-c", PYTHON_WRITE_LICENSE_FILES_SCRIPT, join(androidHome, "licenses")]
        },
        {
          label: "Install Android SDK packages",
          command: sdkmanagerBin,
          args: [
            `--sdk_root=${androidHome}`,
            "platform-tools",
            `platforms;android-${packageVersion}`,
            `build-tools;${getAndroidBuildToolsVersion(packageVersion)}`
          ]
        }
      ],
      wrappers: [
        {
          binaryName: "adb",
          scriptBody: makeExecWrapper(join(androidHome, "platform-tools", "adb")),
          verifyArgs: ["version"]
        },
        {
          binaryName: "sdkmanager",
          scriptBody: makeExecWrapper(sdkmanagerBin),
          verifyArgs: ["--version"]
        }
      ]
    };
  }
}
```

---

## Verification

```bash
docker compose build
docker compose up
```

In Discord:
1. `/install java-temurin` (repo scope) — confirm succeeds
2. `/install android-sdk` (repo scope) — 3 steps, ~5–10 min on LTE
3. `/ask echo $ANDROID_HOME` — should print install path
4. `/ask ./gradlew :androidApp:assembleDebug` — full Android build
