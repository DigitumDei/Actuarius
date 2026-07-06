import { existsSync } from "node:fs";
import { mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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

const ESSENTIAL_ENV_VARS = new Set([
  "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ", "PWD", "TERM", "PATH"
]);

const PROVIDER_AUTH_VARS = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "TOGETHER_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN"
]);

const GITHUB_CLI_VARS = new Set([
  "GH_TOKEN",
  "GH_PROMPT_DISABLED",
  "GH_CONFIG_DIR",
  "GIT_TERMINAL_PROMPT"
]);

// Outbound proxy + custom TLS/CA configuration. A VM that routes egress through
// a proxy or pins a private CA bundle needs these, or every provider/`gh` HTTPS
// call fails under the minimal env. Both upper- and lower-case proxy spellings
// are honored because different HTTP stacks read different cases.
const NETWORK_TLS_VARS = new Set([
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE"
]);

// Runtime/config locators that redirect where a CLI finds its config/cache or
// which API endpoint it talks to. Dropping these silently changes behavior
// (wrong endpoint, missing config dir) instead of failing loudly, so they must
// survive the minimal env when the deployment sets them.
const RUNTIME_CONFIG_VARS = new Set([
  "NODE_OPTIONS",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "OPENAI_BASE_URL", "OPENAI_API_BASE",
  "GEMINI_BASE_URL", "GOOGLE_GEMINI_BASE_URL",
  "OPENCODE_CONFIG",
  "MEMPALACE_PALACE_PATH",
  "MEMPAL_PALACE_PATH",
  "MEMPALACE_EMBED_ALLOW_DOWNLOADS",
  "MEMPALACE_EMBEDDING_PROFILE",
  "MEMPALACE_REMOTE_TOKEN",
  "MEMPALACE_STUB_EMBEDDINGS"
]);

// Operator escape hatch: a comma/whitespace-separated list of additional env
// var NAMES to pass through to provider subprocesses. Lets a deployment add
// site-specific variables (e.g. an internal proxy or bespoke auth var) without
// a code change. Only names are listed here; values still come from process.env.
const EXTRA_ENV_ALLOWLIST_VAR = "EXTRA_EXECUTION_ENV_VARS";

function parseExtraEnvAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean);
}

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
    | "INSTALL_NOT_FOUND"
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
      | "INSTALL_NOT_FOUND"
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
  private readonly pathExists: (path: string) => boolean;

  public constructor(
    config: AppConfig,
    logger: Logger,
    db: AppDatabase,
    pathExists: (path: string) => boolean = existsSync
  ) {
    this.config = config;
    this.logger = logger;
    this.db = db;
    this.pathExists = pathExists;
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
    const installs = this.getUsableInstalls(input);
    const pathEntries = new Set<string>();
    const packages: string[] = [];
    const env: NodeJS.ProcessEnv = { ...process.env };

    for (const { install, envVars } of installs) {
      packages.push(install.package_id);
      if (install.bin_path) {
        pathEntries.add(install.bin_path);
      }

      for (const [key, value] of Object.entries(envVars)) {
        env[key] = value;
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

  public static deduplicatePath(pathValue: string | undefined): string {
    if (!pathValue) return "";
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of pathValue.split(":")) {
      if (entry && !seen.has(entry)) {
        seen.add(entry);
        result.push(entry);
      }
    }
    return result.join(":");
  }

  public buildMinimalExecutionEnvironment(input: {
    repoId: number;
    threadId?: string | null;
    baseEnv?: NodeJS.ProcessEnv;
  }): InstallExecutionEnvironment {
    const sourceEnv = input.baseEnv ?? process.env;
    const installs = this.getUsableInstalls(input);
    const pathEntries = new Set<string>();
    const packages: string[] = [];
    const env: NodeJS.ProcessEnv = {};

    const allowedVars = new Set<string>([
      ...ESSENTIAL_ENV_VARS,
      ...PROVIDER_AUTH_VARS,
      ...GITHUB_CLI_VARS,
      ...NETWORK_TLS_VARS,
      ...RUNTIME_CONFIG_VARS,
      ...parseExtraEnvAllowlist(sourceEnv[EXTRA_ENV_ALLOWLIST_VAR])
    ]);

    for (const key of allowedVars) {
      if (sourceEnv[key] !== undefined) {
        env[key] = sourceEnv[key];
      }
    }

    for (const { install, envVars } of installs) {
      packages.push(install.package_id);
      if (install.bin_path) {
        pathEntries.add(install.bin_path);
      }

      for (const [key, value] of Object.entries(envVars)) {
        env[key] = value;
      }
    }

    const orderedPathEntries = [...pathEntries];
    if (orderedPathEntries.length > 0) {
      const existingPath = env.PATH ?? "";
      const dedupedBase = InstallService.deduplicatePath(existingPath);
      const allEntries = [...orderedPathEntries];
      if (dedupedBase) {
        for (const entry of dedupedBase.split(":")) {
          allEntries.push(entry);
        }
      }
      env.PATH = InstallService.deduplicatePath(allEntries.join(":"));
    }

    return {
      env,
      pathEntries: orderedPathEntries,
      packages
    };
  }

  public async invalidateInstall(input: {
    repoId: number;
    threadId?: string | null;
    packageId: string;
    scope: InstallScope;
    invalidatedByUserId: string;
  }): Promise<InstallRequestRow> {
    const install = this.db.getLatestSuccessfulInstallRequest(input);
    if (!install) {
      throw new InstallServiceError(
        "INSTALL_NOT_FOUND",
        `No active successful install of \`${input.packageId}\` was found in \`${input.scope}\` scope.`
      );
    }

    const activeInstall = this.db.getActiveInstallRequestByRoot(install.install_root);
    if (activeInstall) {
      throw new InstallServiceError(
        "INSTALL_ALREADY_ACTIVE",
        `Install request #${activeInstall.id} is still active for \`${input.packageId}\`.`
      );
    }

    const installsRoot = resolve(this.config.installsRootPath);
    const installRoot = resolve(install.install_root);
    const relativeInstallRoot = relative(installsRoot, installRoot);
    if (!relativeInstallRoot || relativeInstallRoot.startsWith("..") || isAbsolute(relativeInstallRoot)) {
      throw new InstallServiceError("INSTALL_FAILED", `Refusing to remove unmanaged install path \`${install.install_root}\`.`);
    }

    await rm(installRoot, { recursive: true, force: true });
    const completedAt = new Date().toISOString();
    this.db.updateInstallRequest({
      installRequestId: install.id,
      status: "invalidated",
      errorMessage: `Invalidated by Discord user ${input.invalidatedByUserId}.`,
      completedAt
    });

    this.logger.info(
      { installRequestId: install.id, packageId: install.package_id, installRoot, invalidatedByUserId: input.invalidatedByUserId },
      "Managed install invalidated"
    );
    return this.db.getInstallRequestById(install.id)!;
  }

  private getUsableInstalls(input: { repoId: number; threadId?: string | null }): Array<{
    install: InstallRequestRow;
    envVars: Record<string, string>;
  }> {
    const usable: Array<{ install: InstallRequestRow; envVars: Record<string, string> }> = [];

    for (const install of this.db.listSuccessfulInstallRequestsForScope(input)) {
      let envVars: Record<string, string> = {};
      if (install.env_json) {
        try {
          const parsed = JSON.parse(install.env_json) as unknown;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("env_json must contain an object");
          }
          envVars = Object.fromEntries(
            Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
          );
        } catch (error) {
          this.logger.warn({ error, installRequestId: install.id }, "Failed to parse install request env_json");
        }
      }

      const managedPaths = [
        install.install_root,
        ...(install.bin_path ? [install.bin_path] : []),
        ...Object.values(envVars).filter((value) => isAbsolute(value))
      ];
      const missingPath = managedPaths.find((managedPath) => !this.pathExists(managedPath));
      if (missingPath) {
        this.logger.warn(
          {
            installRequestId: install.id,
            packageId: install.package_id,
            scope: install.scope,
            missingPath
          },
          "Skipping stale managed install"
        );
        continue;
      }

      usable.push({ install, envVars });
    }

    return usable;
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
    const orderedPathEntries = pathEntries.filter((entry) => entry.length > 0);
    if (orderedPathEntries.length > 0) {
      env.PATH = `${orderedPathEntries.join(":")}:${base.PATH ?? ""}`;
    } else if (base.PATH !== undefined) {
      env.PATH = base.PATH;
    } else {
      delete env.PATH;
    }
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
