import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InstallScope } from "../db/types.js";

export interface InstallStep {
  label: string;
  command: string;
  args: string[];
}

export interface InstallWrapper {
  binaryName: string;
  scriptBody: string;
  verifyArgs: string[];
}

export interface InstallPlan {
  packageId: string;
  packageVersion: string;
  installRoot: string;
  envVars: Record<string, string>;
  steps: InstallStep[];
  wrappers: InstallWrapper[];
}

export interface ResolvedInstallerPackage {
  packageId: string;
  packageVersion: string;
  summary: string;
  supportedScopes: InstallScope[];
  buildPlan: (installRoot: string) => InstallPlan;
}

export interface InstallerPackageDefinition {
  packageId: string;
  summary: string;
  supportedScopes: InstallScope[];
  defaultVersion?: string;
  resolveVersion?: (repoRoot: string) => string;
  buildPlan: (installRoot: string, packageVersion: string) => InstallPlan;
}

const PYTHON_DOWNLOAD_AND_EXTRACT_SCRIPT = `
import os
import shutil
import sys
import tarfile
import urllib.request
import zipfile

url, archive_path, destination = sys.argv[1:4]
os.makedirs(os.path.dirname(archive_path), exist_ok=True)
tmp_archive = archive_path + ".tmp"
with urllib.request.urlopen(url) as response, open(tmp_archive, "wb") as output:
    shutil.copyfileobj(response, output)
os.replace(tmp_archive, archive_path)

staging = destination + ".staging"
if os.path.exists(staging):
    shutil.rmtree(staging)
os.makedirs(staging, exist_ok=True)

if archive_path.endswith(".zip"):
    with zipfile.ZipFile(archive_path) as archive:
        archive.extractall(staging)
elif archive_path.endswith(".tar.gz") or archive_path.endswith(".tgz"):
    with tarfile.open(archive_path, "r:gz") as archive:
        archive.extractall(staging)
else:
    raise RuntimeError(f"Unsupported archive: {archive_path}")

entries = [name for name in os.listdir(staging) if name not in (".DS_Store", "__MACOSX")]
if os.path.exists(destination):
    shutil.rmtree(destination)

if len(entries) == 1 and os.path.isdir(os.path.join(staging, entries[0])):
    shutil.move(os.path.join(staging, entries[0]), destination)
else:
    os.makedirs(destination, exist_ok=True)
    for name in entries:
        shutil.move(os.path.join(staging, name), os.path.join(destination, name))

shutil.rmtree(staging, ignore_errors=True)
`.trim();

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function makeExecWrapper(target: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
exec ${shellQuote(target)} "$@"
`;
}

function makeDownloadAndExtractStep(label: string, url: string, archivePath: string, destination: string): InstallStep {
  return {
    label,
    command: "python3",
    args: ["-c", PYTHON_DOWNLOAD_AND_EXTRACT_SCRIPT, url, archivePath, destination]
  };
}

function readRepoFile(repoRoot: string, relativePath: string): string | undefined {
  const filePath = join(repoRoot, relativePath);
  if (!existsSync(filePath)) {
    return undefined;
  }

  return readFileSync(filePath, "utf8");
}

function parseKeyValueFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key) {
      entries.set(key, value);
    }
  }

  return entries;
}

function parseToolVersions(content: string): Map<string, string> {
  const entries = new Map<string, string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const [tool, ...valueParts] = line.split(/\s+/);
    const value = valueParts.join(" ").trim();
    if (tool && value) {
      entries.set(tool, value);
    }
  }

  return entries;
}

function requireMatchingVersion(rawVersion: string, pattern: RegExp, message: string): string {
  const value = rawVersion.trim();
  if (!pattern.test(value)) {
    throw new Error(message);
  }

  return value;
}

function resolveJavaVersion(repoRoot: string): string {
  const toolVersions = readRepoFile(repoRoot, ".tool-versions");
  if (toolVersions) {
    const javaVersion = parseToolVersions(toolVersions).get("java");
    if (javaVersion) {
      if (javaVersion.startsWith("temurin-")) {
        return requireMatchingVersion(
          javaVersion.slice("temurin-".length),
          /^\d+(?:\.\d+){0,2}(?:\+\d+)?$/,
          "`.tool-versions` java entries must look like `temurin-21` or `temurin-21.0.3+9`."
        );
      }

      return requireMatchingVersion(
        javaVersion,
        /^\d+(?:\.\d+){0,2}(?:\+\d+)?$/,
        "`.tool-versions` java entries must look like `21` or `21.0.3+9`."
      );
    }
  }

  const javaVersionFile = readRepoFile(repoRoot, ".java-version");
  if (javaVersionFile) {
    return requireMatchingVersion(
      javaVersionFile.trim(),
      /^\d+(?:\.\d+){0,2}(?:\+\d+)?$/,
      "`.java-version` must contain a major version like `21` or an exact Temurin build like `21.0.3+9`."
    );
  }

  const gradleProperties = readRepoFile(repoRoot, "gradle.properties");
  if (gradleProperties) {
    const properties = parseKeyValueFile(gradleProperties);
    const configuredVersion = properties.get("actuarius.java.version");
    if (configuredVersion) {
      return requireMatchingVersion(
        configuredVersion,
        /^\d+(?:\.\d+){0,2}(?:\+\d+)?$/,
        "`gradle.properties` key `actuarius.java.version` must be a major version like `21` or an exact Temurin build like `21.0.3+9`."
      );
    }
  }

  throw new Error(
    "No supported Java version config was found. Checked `.tool-versions`, `.java-version`, and `gradle.properties` (`actuarius.java.version`)."
  );
}

function resolveGradleVersion(repoRoot: string): string {
  const toolVersions = readRepoFile(repoRoot, ".tool-versions");
  if (toolVersions) {
    const gradleVersion = parseToolVersions(toolVersions).get("gradle");
    if (gradleVersion) {
      return requireMatchingVersion(
        gradleVersion,
        /^\d+(?:\.\d+){0,2}$/,
        "`.tool-versions` gradle entries must look like `8.10`."
      );
    }
  }

  const wrapperProperties = readRepoFile(repoRoot, "gradle/wrapper/gradle-wrapper.properties");
  if (wrapperProperties) {
    const distributionUrl = parseKeyValueFile(wrapperProperties).get("distributionUrl");
    if (distributionUrl) {
      const match = distributionUrl.match(/gradle-([0-9]+(?:\.[0-9]+){1,2})-(?:bin|all)\.zip$/);
      if (!match?.[1]) {
        throw new Error("`gradle-wrapper.properties` distributionUrl did not contain a supported Gradle version.");
      }
      return match[1];
    }
  }

  const gradleProperties = readRepoFile(repoRoot, "gradle.properties");
  if (gradleProperties) {
    const properties = parseKeyValueFile(gradleProperties);
    const configuredVersion = properties.get("actuarius.gradle.version");
    if (configuredVersion) {
      return requireMatchingVersion(
        configuredVersion,
        /^\d+(?:\.\d+){0,2}$/,
        "`gradle.properties` key `actuarius.gradle.version` must look like `8.10`."
      );
    }
  }

  throw new Error(
    "No supported Gradle version config was found. Checked `.tool-versions`, `gradle/wrapper/gradle-wrapper.properties`, and `gradle.properties` (`actuarius.gradle.version`)."
  );
}

function resolveKotlinVersion(repoRoot: string): string {
  const toolVersions = readRepoFile(repoRoot, ".tool-versions");
  if (toolVersions) {
    const kotlinVersion = parseToolVersions(toolVersions).get("kotlin");
    if (kotlinVersion) {
      return requireMatchingVersion(
        kotlinVersion,
        /^\d+(?:\.\d+){1,2}$/,
        "`.tool-versions` kotlin entries must look like `2.1.21`."
      );
    }
  }

  const gradleProperties = readRepoFile(repoRoot, "gradle.properties");
  if (gradleProperties) {
    const properties = parseKeyValueFile(gradleProperties);
    const configuredVersion = properties.get("actuarius.kotlin.version") ?? properties.get("kotlin.version");
    if (configuredVersion) {
      return requireMatchingVersion(
        configuredVersion,
        /^\d+(?:\.\d+){1,2}$/,
        "`gradle.properties` Kotlin version entries must look like `2.1.21`."
      );
    }
  }

  throw new Error(
    "No supported Kotlin version config was found. Checked `.tool-versions` and `gradle.properties` (`actuarius.kotlin.version` or `kotlin.version`)."
  );
}

function buildJavaDownloadUrl(version: string): string {
  if (/^\d+$/.test(version)) {
    return `https://api.adoptium.net/v3/binary/latest/${version}/ga/linux/x64/jdk/hotspot/normal/eclipse`;
  }

  return `https://api.adoptium.net/v3/binary/version/${encodeURIComponent(`jdk-${version}`)}/linux/x64/jdk/hotspot/normal/eclipse`;
}

const packageDefinitions: InstallerPackageDefinition[] = [
  {
    packageId: "rustup-default-stable",
    defaultVersion: "stable",
    summary: "Scoped Rust stable toolchain wrappers for cargo, rustc, and rustfmt.",
    supportedScopes: ["repo", "request"],
    buildPlan: (installRoot, packageVersion) => {
      const cargoHome = join(installRoot, "cargo");
      const rustupHome = join(installRoot, "rustup");
      const envVars = {
        CARGO_HOME: cargoHome,
        RUSTUP_HOME: rustupHome,
        RUSTUP_TOOLCHAIN: packageVersion
      };

      return {
        packageId: "rustup-default-stable",
        packageVersion,
        installRoot,
        envVars,
        steps: [
          {
            label: "Install Rust stable toolchain",
            command: "rustup",
            args: ["toolchain", "install", packageVersion, "--profile", "minimal", "--no-self-update"]
          }
        ],
        wrappers: [
          {
            binaryName: "cargo",
            scriptBody: `#!/usr/bin/env bash
set -euo pipefail
export CARGO_HOME=${shellQuote(cargoHome)}
export RUSTUP_HOME=${shellQuote(rustupHome)}
export RUSTUP_TOOLCHAIN=${shellQuote(packageVersion)}
exec rustup run ${shellQuote(packageVersion)} cargo "$@"
`,
            verifyArgs: ["--version"]
          },
          {
            binaryName: "rustc",
            scriptBody: `#!/usr/bin/env bash
set -euo pipefail
export CARGO_HOME=${shellQuote(cargoHome)}
export RUSTUP_HOME=${shellQuote(rustupHome)}
export RUSTUP_TOOLCHAIN=${shellQuote(packageVersion)}
exec rustup run ${shellQuote(packageVersion)} rustc "$@"
`,
            verifyArgs: ["--version"]
          },
          {
            binaryName: "rustfmt",
            scriptBody: `#!/usr/bin/env bash
set -euo pipefail
export CARGO_HOME=${shellQuote(cargoHome)}
export RUSTUP_HOME=${shellQuote(rustupHome)}
export RUSTUP_TOOLCHAIN=${shellQuote(packageVersion)}
exec rustup run ${shellQuote(packageVersion)} rustfmt "$@"
`,
            verifyArgs: ["--version"]
          }
        ]
      };
    }
  },
  {
    packageId: "npm-prettier",
    defaultVersion: "3",
    summary: "Scoped Prettier CLI installed via npm.",
    supportedScopes: ["repo", "request"],
    buildPlan: (installRoot, packageVersion) => {
      const npmPrefix = join(installRoot, "npm");
      const prettierBinary = join(npmPrefix, "node_modules", ".bin", "prettier");

      return {
        packageId: "npm-prettier",
        packageVersion,
        installRoot,
        envVars: {},
        steps: [
          {
            label: "Install Prettier via npm",
            command: "npm",
            args: ["install", "--no-fund", "--no-audit", "--prefix", npmPrefix, `prettier@^${packageVersion}`]
          }
        ],
        wrappers: [
          {
            binaryName: "prettier",
            scriptBody: makeExecWrapper(prettierBinary),
            verifyArgs: ["--version"]
          }
        ]
      };
    }
  },
  {
    packageId: "java-temurin",
    summary: "Temurin JDK resolved from repo config (`.tool-versions`, `.java-version`, or `gradle.properties`).",
    supportedScopes: ["repo", "request"],
    resolveVersion: resolveJavaVersion,
    buildPlan: (installRoot, packageVersion) => {
      const archivePath = join(installRoot, "downloads", "java.tar.gz");
      const javaHome = join(installRoot, "home");

      return {
        packageId: "java-temurin",
        packageVersion,
        installRoot,
        envVars: {
          JAVA_HOME: javaHome
        },
        steps: [makeDownloadAndExtractStep("Install Temurin JDK", buildJavaDownloadUrl(packageVersion), archivePath, javaHome)],
        wrappers: [
          {
            binaryName: "java",
            scriptBody: makeExecWrapper(join(javaHome, "bin", "java")),
            verifyArgs: ["-version"]
          },
          {
            binaryName: "javac",
            scriptBody: makeExecWrapper(join(javaHome, "bin", "javac")),
            verifyArgs: ["-version"]
          }
        ]
      };
    }
  },
  {
    packageId: "gradle",
    summary: "Gradle distribution resolved from repo config (`.tool-versions`, Gradle wrapper, or `gradle.properties`).",
    supportedScopes: ["repo", "request"],
    resolveVersion: resolveGradleVersion,
    buildPlan: (installRoot, packageVersion) => {
      const archivePath = join(installRoot, "downloads", "gradle.zip");
      const gradleHome = join(installRoot, "home");

      return {
        packageId: "gradle",
        packageVersion,
        installRoot,
        envVars: {
          GRADLE_HOME: gradleHome
        },
        steps: [
          makeDownloadAndExtractStep(
            "Install Gradle distribution",
            `https://services.gradle.org/distributions/gradle-${packageVersion}-bin.zip`,
            archivePath,
            gradleHome
          )
        ],
        wrappers: [
          {
            binaryName: "gradle",
            scriptBody: makeExecWrapper(join(gradleHome, "bin", "gradle")),
            verifyArgs: ["--version"]
          }
        ]
      };
    }
  },
  {
    packageId: "kotlin-compiler",
    summary: "Kotlin compiler resolved from repo config (`.tool-versions` or `gradle.properties`).",
    supportedScopes: ["repo", "request"],
    resolveVersion: resolveKotlinVersion,
    buildPlan: (installRoot, packageVersion) => {
      const archivePath = join(installRoot, "downloads", "kotlin.zip");
      const kotlinHome = join(installRoot, "home");

      return {
        packageId: "kotlin-compiler",
        packageVersion,
        installRoot,
        envVars: {
          KOTLIN_HOME: kotlinHome
        },
        steps: [
          makeDownloadAndExtractStep(
            "Install Kotlin compiler",
            `https://github.com/JetBrains/kotlin/releases/download/v${packageVersion}/kotlin-compiler-${packageVersion}.zip`,
            archivePath,
            kotlinHome
          )
        ],
        wrappers: [
          {
            binaryName: "kotlinc",
            scriptBody: makeExecWrapper(join(kotlinHome, "bin", "kotlinc")),
            verifyArgs: ["-version"]
          },
          {
            binaryName: "kotlin",
            scriptBody: makeExecWrapper(join(kotlinHome, "bin", "kotlin")),
            verifyArgs: ["-version"]
          }
        ]
      };
    }
  }
];

export const INSTALLER_PACKAGE_CHOICES = packageDefinitions.map((definition) => ({
  name: definition.packageId,
  value: definition.packageId
})) as Array<{ name: string; value: string }>;

export function listInstallerPackages(): InstallerPackageDefinition[] {
  return [...packageDefinitions];
}

export function getInstallerPackageDefinition(packageId: string): InstallerPackageDefinition | undefined {
  return packageDefinitions.find((pkg) => pkg.packageId === packageId);
}

export function resolveInstallerPackage(packageId: string, repoRoot?: string): ResolvedInstallerPackage | undefined {
  const definition = getInstallerPackageDefinition(packageId);
  if (!definition) {
    return undefined;
  }

  const packageVersion = definition.resolveVersion ? definition.resolveVersion(repoRoot ?? "") : definition.defaultVersion;
  if (!packageVersion) {
    throw new Error(`Package \`${packageId}\` does not define a default version.`);
  }

  return {
    packageId: definition.packageId,
    packageVersion,
    summary: definition.summary,
    supportedScopes: definition.supportedScopes,
    buildPlan: (installRoot: string) => definition.buildPlan(installRoot, packageVersion)
  };
}
