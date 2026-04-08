import { existsSync } from "node:fs";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import type { InstallRequestRow, InstallScope } from "../db/types.js";
import { buildRepoCheckoutPath } from "./gitWorkspaceService.js";
import {
  getAptPackageSpec,
  getInstallerPackageDefinition,
  isAptPackageId,
  listInstallerPackages,
  resolveInstallerPackage
} from "./installerRegistry.js";
import { spawnCollect } from "../utils/spawnCollect.js";

const INSTALL_BUFFER_LIMIT = 4 * 1024 * 1024;

export class InstallServiceError extends Error {
  public readonly code:
    | "UNKNOWN_PACKAGE"
    | "UNSUPPORTED_SCOPE"
    | "INVALID_SCOPE"
    | "INSTALL_ALREADY_ACTIVE"
    | "CONFIG_NOT_FOUND"
    | "CONFIG_INVALID"
    | "INSTALL_FAILED"
    | "INSTALL_UNAVAILABLE"
    | "VERIFY_FAILED";

  public constructor(
    code:
      | "UNKNOWN_PACKAGE"
      | "UNSUPPORTED_SCOPE"
      | "INVALID_SCOPE"
      | "INSTALL_ALREADY_ACTIVE"
      | "CONFIG_NOT_FOUND"
      | "CONFIG_INVALID"
      | "INSTALL_FAILED"
      | "INSTALL_UNAVAILABLE"
      | "VERIFY_FAILED",
    message: string
  ) {
    super(message);
    this.name = "InstallServiceError";
    this.code = code;
  }
}

export interface InstallExecutionEnvironment {
  env: NodeJS.ProcessEnv;
  pathEntries: string[];
  packages: string[];
}

export class InstallService {
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly db: AppDatabase;

  public constructor(config: AppConfig, logger: Logger, db: AppDatabase) {
    this.config = config;
    this.logger = logger;
    this.db = db;
  }

  public listAllowedPackages(): Array<{ packageId: string; summary: string }> {
    return listInstallerPackages().map((pkg) => ({
      packageId: pkg.packageId,
      summary: pkg.summary
    }));
  }

  public createApprovedInstallRequest(input: {
    guildId: string;
    repoId: number;
    requestId?: number | null;
    threadId?: string | null;
    packageId: string;
    scope: InstallScope;
    requestedByUserId: string;
    approvedByUserId: string;
  }): InstallRequestRow {
    const sourceRoot = this.getInstallSourceRoot({
      repoId: input.repoId,
      scope: input.scope,
      requestId: input.requestId ?? null
    });

    let pkg: ReturnType<typeof resolveInstallerPackage>;
    try {
      pkg = resolveInstallerPackage(input.packageId, sourceRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Install config could not be resolved.";
      throw new InstallServiceError(message.startsWith("No supported") ? "CONFIG_NOT_FOUND" : "CONFIG_INVALID", message);
    }

    if (!pkg) {
      throw new InstallServiceError("UNKNOWN_PACKAGE", `Package \`${input.packageId}\` is not allowlisted.`);
    }
    if (input.scope !== "repo" && input.scope !== "request") {
      throw new InstallServiceError("INVALID_SCOPE", `Install scope \`${input.scope}\` is not supported.`);
    }
    if (!pkg.supportedScopes.includes(input.scope)) {
      throw new InstallServiceError("UNSUPPORTED_SCOPE", `Package \`${input.packageId}\` does not support \`${input.scope}\` scope.`);
    }

    const installRoot = this.getScopedPackageRoot({
      packageId: input.packageId,
      scope: input.scope,
      repoId: input.repoId,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {})
    });
    const activeInstall = this.db.getActiveInstallRequestByRoot(installRoot);
    if (activeInstall) {
      throw new InstallServiceError(
        "INSTALL_ALREADY_ACTIVE",
        `Package \`${input.packageId}\` is already installing for this ${input.scope} target via install request #${activeInstall.id}.`
      );
    }

    const installRequest = this.db.createInstallRequest({
      guildId: input.guildId,
      repoId: input.repoId,
      requestId: input.requestId ?? null,
      threadId: input.threadId ?? null,
      packageId: input.packageId,
      packageVersion: pkg.packageVersion,
      scope: input.scope,
      status: "approved",
      requestedByUserId: input.requestedByUserId,
      approvedByUserId: input.approvedByUserId,
      installRoot
    });

    if (installRequest.request_id !== null) {
      this.db.updateRequestStatus(installRequest.request_id, "install_approved");
    }

    return installRequest;
  }

  public async runInstall(installRequestId: number): Promise<InstallRequestRow> {
    const installRequest = this.db.getInstallRequestById(installRequestId);
    if (!installRequest) {
      throw new InstallServiceError("INSTALL_FAILED", `Install request #${installRequestId} was not found.`);
    }

    const pkg = getInstallerPackageDefinition(installRequest.package_id);
    if (!pkg) {
      throw new InstallServiceError("UNKNOWN_PACKAGE", `Package \`${installRequest.package_id}\` is not allowlisted.`);
    }

    if (isAptPackageId(installRequest.package_id)) {
      this.assertAptInstallAvailable();
    }

    const plan = this.buildInstallPlan(installRequest.package_id, installRequest.install_root, installRequest.package_version, pkg);
    const binDir = plan.binDir === undefined ? join(plan.installRoot, "bin") : plan.binDir;
    const scopeEnv = this.buildExecutionEnvironment({
      repoId: installRequest.repo_id,
      threadId: installRequest.thread_id
    });
    const env = this.mergeInstallEnvironment(plan.envVars, binDir ? [binDir] : [], scopeEnv.env);
    const logs: string[] = [];

    this.db.updateInstallRequest({
      installRequestId,
      status: "running",
      ...(binDir ? { binPath: binDir } : {})
    });
    if (installRequest.request_id !== null) {
      this.db.updateRequestStatus(installRequest.request_id, "install_running");
    }

    try {
      await mkdir(plan.installRoot, { recursive: true });
      if (binDir) {
        await mkdir(binDir, { recursive: true });
      }

      for (const step of plan.steps) {
        logs.push(`$ ${step.command} ${step.args.join(" ")}`);
        try {
          const { stdout, stderr } = await spawnCollect(step.command, step.args, {
            cwd: plan.installRoot,
            env,
            timeoutMs: this.config.installStepTimeoutMs,
            maxBuffer: INSTALL_BUFFER_LIMIT
          });
          if (stdout.trim()) {
            logs.push(stdout.trim());
          }
          if (stderr.trim()) {
            logs.push(stderr.trim());
          }
        } catch (error) {
          const message = this.describeProcessError(step.command, error);
          logs.push(message);
          throw new InstallServiceError(
            error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "INSTALL_UNAVAILABLE"
              : "INSTALL_FAILED",
            message
          );
        }
      }

      for (const wrapper of plan.wrappers) {
        if (!binDir) {
          throw new InstallServiceError("INSTALL_FAILED", `Package \`${installRequest.package_id}\` does not define a bin directory.`);
        }

        const wrapperPath = join(binDir, wrapper.binaryName);
        await writeFile(wrapperPath, wrapper.scriptBody, "utf8");
        await chmod(wrapperPath, 0o755);

        let stdout = "";
        let stderr = "";
        try {
          ({ stdout, stderr } = await spawnCollect(wrapperPath, wrapper.verifyArgs, {
            cwd: plan.installRoot,
            env,
            timeoutMs: this.config.installStepTimeoutMs,
            maxBuffer: INSTALL_BUFFER_LIMIT
          }));
        } catch (error) {
          const message = this.describeProcessError(wrapper.binaryName, error);
          logs.push(`$ ${wrapper.binaryName} ${wrapper.verifyArgs.join(" ")}`);
          logs.push(message);
          throw new InstallServiceError("VERIFY_FAILED", message);
        }

        logs.push(`$ ${wrapper.binaryName} ${wrapper.verifyArgs.join(" ")}`);
        if (stdout.trim()) {
          logs.push(stdout.trim());
        }
        if (stderr.trim()) {
          logs.push(stderr.trim());
        }
      }

      this.db.updateInstallRequest({
        installRequestId,
        status: "succeeded",
        approvedByUserId: installRequest.approved_by_user_id,
        ...(binDir ? { binPath: binDir } : {}),
        envJson: JSON.stringify(plan.envVars),
        logs: logs.join("\n\n"),
        completedAt: new Date().toISOString()
      });
      if (installRequest.request_id !== null) {
        this.db.updateRequestStatus(installRequest.request_id, "install_succeeded");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Install failed.";
      this.db.updateInstallRequest({
        installRequestId,
        status: "failed",
        approvedByUserId: installRequest.approved_by_user_id,
        ...(binDir ? { binPath: binDir } : {}),
        envJson: JSON.stringify(plan.envVars),
        logs: logs.join("\n\n"),
        errorMessage: message,
        completedAt: new Date().toISOString()
      });
      if (installRequest.request_id !== null) {
        this.db.updateRequestStatus(installRequest.request_id, "install_failed");
      }
      throw error;
    }

    return this.db.getInstallRequestById(installRequestId)!;
  }

  public buildExecutionEnvironment(input: { repoId: number; threadId?: string | null }): InstallExecutionEnvironment {
    const installs = this.db.listSuccessfulInstallRequestsForScope(input);
    const pathEntries = new Set<string>();
    const packages: string[] = [];
    const env: NodeJS.ProcessEnv = { ...process.env };

    for (const install of installs) {
      packages.push(install.package_id);
      if (install.bin_path) {
        pathEntries.add(install.bin_path);
      }

      if (install.env_json) {
        try {
          const parsed = JSON.parse(install.env_json) as Record<string, string>;
          for (const [key, value] of Object.entries(parsed)) {
            env[key] = value;
          }
        } catch (error) {
          this.logger.warn({ error, installRequestId: install.id }, "Failed to parse install request env_json");
        }
      }
    }

    const orderedPathEntries = [...pathEntries];
    if (orderedPathEntries.length > 0) {
      env.PATH = `${orderedPathEntries.join(":")}:${process.env.PATH ?? ""}`;
    }

    return {
      env,
      pathEntries: orderedPathEntries,
      packages
    };
  }

  private getScopedPackageRoot(input: {
    packageId: string;
    scope: InstallScope;
    repoId: number;
    threadId?: string | null;
  }): string {
    if (isAptPackageId(input.packageId)) {
      return join(this.config.installsRootPath, "system", this.getInstallRootSegment(input.packageId));
    }

    if (input.scope === "repo") {
      return join(this.config.installsRootPath, "repo", String(input.repoId), input.packageId);
    }

    if (!input.threadId) {
      throw new InstallServiceError("INVALID_SCOPE", "Request-scoped installs require an active request thread.");
    }

    return join(this.config.installsRootPath, "request", input.threadId, input.packageId);
  }

  private getInstallRootSegment(packageId: string): string {
    if (isAptPackageId(packageId)) {
      return `apt-${Buffer.from(packageId, "utf8").toString("base64url")}`;
    }

    return packageId;
  }

  private getInstallSourceRoot(input: { repoId: number; scope: InstallScope; requestId?: number | null }): string {
    if (input.scope === "request") {
      const requestId = input.requestId;
      if (!requestId) {
        throw new InstallServiceError("INVALID_SCOPE", "Request-scoped installs require an active request.");
      }

      const request = this.db.getRequestById(requestId);
      if (!request?.worktree_path) {
        throw new InstallServiceError("INVALID_SCOPE", "Request-scoped installs require a tracked worktree.");
      }

      return request.worktree_path;
    }

    const repo = this.db.getRepoById(input.repoId);
    if (!repo) {
      throw new InstallServiceError("INSTALL_FAILED", `Repository #${input.repoId} was not found.`);
    }

    return buildRepoCheckoutPath(this.config.reposRootPath, repo.owner, repo.repo);
  }

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

  private describeProcessError(command: string, error: unknown): string {
    const message = error instanceof Error ? error.message : "Process failed.";
    const nodeError = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const stderr = nodeError.stderr?.trim();
    const stdout = nodeError.stdout?.trim();
    return [command, message, stderr, stdout].filter(Boolean).join(": ");
  }

  private buildInstallPlan(
    packageId: string,
    installRoot: string,
    packageVersion: string,
    pkg: ReturnType<typeof getInstallerPackageDefinition>
  ) {
    if (pkg && isAptPackageId(packageId) && this.shouldUseAptHelper()) {
      const packageSpec = getAptPackageSpec(packageId);
      const helperPath = this.config.aptInstallHelperPath;
      if (!packageSpec || !helperPath) {
        throw new InstallServiceError("INSTALL_UNAVAILABLE", "APT install helper configuration is invalid.");
      }

      return {
        packageId,
        packageVersion,
        installRoot,
        binDir: null,
        envVars: {},
        steps: [
          {
            label: "Install APT packages",
            command: "sudo",
            args: [helperPath, ...packageSpec.split(" ")]
          }
        ],
        wrappers: []
      };
    }

    return pkg!.buildPlan(installRoot, packageVersion);
  }

  private shouldUseAptHelper(): boolean {
    return isRootUnavailable() && Boolean(this.config.aptInstallHelperPath);
  }

  private assertAptInstallAvailable(): void {
    if (!isRootUnavailable()) {
      return;
    }

    const helperPath = this.config.aptInstallHelperPath;
    if (helperPath && existsSync(helperPath)) {
      return;
    }

    if (helperPath && !existsSync(helperPath)) {
      throw new InstallServiceError(
        "INSTALL_UNAVAILABLE",
        `APT installs require root privileges. Configured helper \`${helperPath}\` was not found or is not mounted in this runtime.`
      );
    }

    throw new InstallServiceError(
      "INSTALL_UNAVAILABLE",
      "APT installs require root privileges. This runtime is not running as root, and no APT install helper is configured."
    );
  }
}

function isRootUnavailable(): boolean {
  return typeof process.getuid === "function" && process.getuid() !== 0;
}
