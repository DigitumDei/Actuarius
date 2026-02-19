import { spawnSync } from "node:child_process";
import type pino from "pino";

interface CapabilityCheck {
  capability: string;
  command: string;
  args: string[];
}

const checks: CapabilityCheck[] = [
  { capability: "git", command: "git", args: ["--version"] },
  { capability: "gh", command: "gh", args: ["--version"] },
  { capability: "node", command: "node", args: ["--version"] },
  { capability: "npm", command: "npm", args: ["--version"] },
  { capability: "codex", command: "codex", args: ["--version"] },
  { capability: "claude", command: "claude", args: ["--version"] },
  { capability: "gemini", command: "gemini", args: ["--version"] }
];

export function runCapabilityChecks(logger: pino.Logger): void {
  for (const check of checks) {
    const result = spawnSync(check.command, check.args, {
      encoding: "utf8",
      timeout: 8_000
    });

    if (result.error || result.status !== 0) {
      logger.warn(
        {
          capability: check.capability,
          command: `${check.command} ${check.args.join(" ")}`,
          exitCode: result.status,
          error: result.error?.message,
          stderr: result.stderr?.trim()
        },
        "Capability check failed"
      );
      continue;
    }

    logger.info(
      {
        capability: check.capability,
        versionOutput: result.stdout.trim()
      },
      "Capability check passed"
    );
  }
}

