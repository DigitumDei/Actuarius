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

export interface InstallerPackageDefinition {
  packageId: string;
  version: string;
  summary: string;
  supportedScopes: InstallScope[];
  buildPlan: (installRoot: string) => InstallPlan;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function makeExecWrapper(target: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
exec ${shellQuote(target)} "$@"
`;
}

const packageDefinitions: InstallerPackageDefinition[] = [
  {
    packageId: "rustup-default-stable",
    version: "stable",
    summary: "Scoped Rust stable toolchain wrappers for cargo, rustc, and rustfmt.",
    supportedScopes: ["repo", "request"],
    buildPlan: (installRoot) => {
      const cargoHome = join(installRoot, "cargo");
      const rustupHome = join(installRoot, "rustup");
      const envVars = {
        CARGO_HOME: cargoHome,
        RUSTUP_HOME: rustupHome,
        RUSTUP_TOOLCHAIN: "stable"
      };

      return {
        packageId: "rustup-default-stable",
        packageVersion: "stable",
        installRoot,
        envVars,
        steps: [
          {
            label: "Install Rust stable toolchain",
            command: "rustup",
            args: ["toolchain", "install", "stable", "--profile", "minimal", "--no-self-update"]
          }
        ],
        wrappers: [
          {
            binaryName: "cargo",
            scriptBody: `#!/usr/bin/env bash
set -euo pipefail
export CARGO_HOME=${shellQuote(cargoHome)}
export RUSTUP_HOME=${shellQuote(rustupHome)}
export RUSTUP_TOOLCHAIN=stable
exec rustup run stable cargo "$@"
`,
            verifyArgs: ["--version"]
          },
          {
            binaryName: "rustc",
            scriptBody: `#!/usr/bin/env bash
set -euo pipefail
export CARGO_HOME=${shellQuote(cargoHome)}
export RUSTUP_HOME=${shellQuote(rustupHome)}
export RUSTUP_TOOLCHAIN=stable
exec rustup run stable rustc "$@"
`,
            verifyArgs: ["--version"]
          },
          {
            binaryName: "rustfmt",
            scriptBody: `#!/usr/bin/env bash
set -euo pipefail
export CARGO_HOME=${shellQuote(cargoHome)}
export RUSTUP_HOME=${shellQuote(rustupHome)}
export RUSTUP_TOOLCHAIN=stable
exec rustup run stable rustfmt "$@"
`,
            verifyArgs: ["--version"]
          }
        ]
      };
    }
  },
  {
    packageId: "npm-prettier",
    version: "3",
    summary: "Scoped Prettier CLI installed via npm.",
    supportedScopes: ["repo", "request"],
    buildPlan: (installRoot) => {
      const npmPrefix = join(installRoot, "npm");
      const prettierBinary = join(npmPrefix, "node_modules", ".bin", "prettier");

      return {
        packageId: "npm-prettier",
        packageVersion: "3",
        installRoot,
        envVars: {},
        steps: [
          {
            label: "Install Prettier via npm",
            command: "npm",
            args: ["install", "--no-fund", "--no-audit", "--prefix", npmPrefix, "prettier@^3"]
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
  }
];

export const INSTALLER_PACKAGE_CHOICES = packageDefinitions.map((definition) => ({
  name: definition.packageId,
  value: definition.packageId
})) as Array<{ name: string; value: string }>;

export function listInstallerPackages(): InstallerPackageDefinition[] {
  return [...packageDefinitions];
}

export function getInstallerPackage(packageId: string): InstallerPackageDefinition | undefined {
  return packageDefinitions.find((definition) => definition.packageId === packageId);
}
