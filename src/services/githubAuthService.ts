import { execFile, spawn } from "node:child_process";
import { createSign } from "node:crypto";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";

const execFileAsync = promisify(execFile);

const GITHUB_HOST = "github.com";
const GITHUB_API_BASE_URL = "https://api.github.com";
const APP_JWT_TTL_SECONDS = 9 * 60;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_RETRY_MS = 60 * 1000;

export interface GitIdentity {
  userName: string;
  userEmail: string;
}

interface InstallationToken {
  token: string;
  expiresAtMs: number;
}

interface GitHubAppInfoResponse {
  slug?: unknown;
}

interface GitHubInstallationTokenResponse {
  token?: unknown;
  expires_at?: unknown;
}

type GitHubAuthSource = "none" | "gh_token" | "github_app";

class GitHubAuthError extends Error {
  public readonly code:
    | "AUTH_LOGIN_FAILED"
    | "INVALID_APP_RESPONSE"
    | "INVALID_INSTALLATION_TOKEN"
    | "TOKEN_EXCHANGE_FAILED";

  public constructor(
    code: "AUTH_LOGIN_FAILED" | "INVALID_APP_RESPONSE" | "INVALID_INSTALLATION_TOKEN" | "TOKEN_EXCHANGE_FAILED",
    message: string
  ) {
    super(message);
    this.name = "GitHubAuthError";
    this.code = code;
  }
}

export function normalizeGitHubSecretValue(rawValue: string): string {
  return rawValue.trim().replace(/\r\n/g, "\n").replace(/\\n/g, "\n");
}

export function resolveGitHubAppPrivateKey(rawValue?: string, rawValueB64?: string): string | null {
  if (rawValueB64) {
    return normalizeGitHubSecretValue(Buffer.from(rawValueB64, "base64").toString("utf8"));
  }

  if (rawValue) {
    return normalizeGitHubSecretValue(rawValue);
  }

  return null;
}

export function deriveGitHubAppIdentity(appId: string, slug: string): GitIdentity {
  const botHandle = `${slug}[bot]`;
  return {
    userName: botHandle,
    userEmail: `${appId}+${botHandle}@users.noreply.github.com`
  };
}

export function getGitCredentialConfigArgs(): string[] {
  return ["-c", "credential.helper=!gh auth git-credential", "-c", "credential.useHttpPath=true"];
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function createGitHubAppJwt(appId: string, privateKey: string, nowMs: number): string {
  const issuedAtSeconds = Math.floor(nowMs / 1000) - 60;
  const payload = {
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + APP_JWT_TTL_SECONDS,
    iss: appId
  };

  const encodedHeader = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();

  const signature = signer.sign(privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function buildGitHubApiErrorMessage(path: string, status: number, payload: unknown): string {
  const message =
    payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
      ? payload.message
      : `GitHub API request to ${path} failed with status ${status}.`;

  return `${message} (${path})`;
}

class GitHubAuthManager {
  private readonly source: GitHubAuthSource;
  private readonly privateKey: string | null;
  private cachedInstallationToken: InstallationToken | null = null;
  private refreshPromise: Promise<void> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private appSlug: string | null = null;
  private initialized = false;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {
    this.privateKey = resolveGitHubAppPrivateKey(config.githubAppPrivateKey, config.githubAppPrivateKeyB64);
    if (config.githubAppId && config.githubAppInstallationId && this.privateKey) {
      this.source = "github_app";
    } else if (config.ghToken) {
      this.source = "gh_token";
    } else {
      this.source = "none";
    }
  }

  public async initialize(): Promise<void> {
    this.applySharedEnvironment();
    this.initialized = true;

    if (this.source === "none") {
      this.logger.info("GitHub auth will use existing gh host auth or anonymous access");
      return;
    }

    await this.refreshAuthentication();
    this.logger.info({ source: this.source }, "Initialized GitHub authentication");
  }

  public getCommandEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return {
      ...baseEnv,
      ...(this.source === "none" ? {} : { GH_CONFIG_DIR: this.config.githubCliConfigPath }),
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0"
    };
  }

  public async ensureReady(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
      return;
    }

    if (this.source !== "github_app") {
      return;
    }

    if (!this.cachedInstallationToken || this.isExpiringSoon(this.cachedInstallationToken.expiresAtMs)) {
      await this.refreshAuthentication();
    }
  }

  public async configureRepository(localPath: string): Promise<void> {
    await this.ensureReady();
    const env = this.getCommandEnvironment();

    await configureRepositoryCredentialHelper(localPath, env);

    const identity = this.resolveGitIdentity();
    if (!identity) {
      return;
    }

    await execFileAsync("git", ["-C", localPath, "config", "user.name", identity.userName], {
      env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    });
    await execFileAsync("git", ["-C", localPath, "config", "user.email", identity.userEmail], {
      env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    });
  }

  private applySharedEnvironment(): void {
    process.env.GH_PROMPT_DISABLED = "1";
    process.env.GIT_TERMINAL_PROMPT = "0";

    if (this.source !== "none") {
      process.env.GH_CONFIG_DIR = this.config.githubCliConfigPath;
    }
  }

  private isExpiringSoon(expiresAtMs: number): boolean {
    return Date.now() >= expiresAtMs - TOKEN_REFRESH_BUFFER_MS;
  }

  private async refreshAuthentication(): Promise<void> {
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }

    this.refreshPromise = (async () => {
      const token = await this.resolveCliToken();
      await this.loginGh(token);
    })();

    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async resolveCliToken(): Promise<string> {
    if (this.source === "gh_token") {
      return this.config.ghToken!;
    }

    if (this.source !== "github_app" || !this.privateKey) {
      throw new GitHubAuthError("INVALID_INSTALLATION_TOKEN", "GitHub auth is not configured.");
    }

    if (this.cachedInstallationToken && !this.isExpiringSoon(this.cachedInstallationToken.expiresAtMs)) {
      return this.cachedInstallationToken.token;
    }

    const jwt = createGitHubAppJwt(this.config.githubAppId!, this.privateKey, Date.now());
    const slug = await this.fetchAppSlug(jwt);
    const payload = await this.fetchGitHubJson<GitHubInstallationTokenResponse>(
      `/app/installations/${this.config.githubAppInstallationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`
        }
      }
    );

    if (typeof payload.token !== "string" || typeof payload.expires_at !== "string") {
      throw new GitHubAuthError("INVALID_INSTALLATION_TOKEN", "GitHub App token response was missing token details.");
    }

    const expiresAtMs = Date.parse(payload.expires_at);
    if (!Number.isFinite(expiresAtMs)) {
      throw new GitHubAuthError("INVALID_INSTALLATION_TOKEN", "GitHub App token expiry could not be parsed.");
    }

    this.appSlug = slug;
    this.cachedInstallationToken = {
      token: payload.token,
      expiresAtMs
    };
    this.scheduleRefresh(expiresAtMs);

    return payload.token;
  }

  private async fetchAppSlug(jwt: string): Promise<string> {
    if (this.appSlug) {
      return this.appSlug;
    }

    const payload = await this.fetchGitHubJson<GitHubAppInfoResponse>("/app", {
      headers: {
        Authorization: `Bearer ${jwt}`
      }
    });

    if (typeof payload.slug !== "string" || !payload.slug) {
      throw new GitHubAuthError("INVALID_APP_RESPONSE", "GitHub App metadata did not include a slug.");
    }

    this.appSlug = payload.slug;
    return payload.slug;
  }

  private async fetchGitHubJson<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Actuarius",
        ...(init.headers ?? {})
      }
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new GitHubAuthError("TOKEN_EXCHANGE_FAILED", buildGitHubApiErrorMessage(path, response.status, payload));
    }

    return payload as T;
  }

  private async loginGh(token: string): Promise<void> {
    const env = this.getCommandEnvironment();

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "gh",
        ["auth", "login", "--hostname", GITHUB_HOST, "--git-protocol", "https", "--with-token"],
        {
          env,
          stdio: ["pipe", "pipe", "pipe"]
        }
      );

      let stderr = "";
      let stdout = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(
          new GitHubAuthError(
            "AUTH_LOGIN_FAILED",
            [stderr.trim(), stdout.trim(), `gh auth login exited with code ${String(code)}.`].filter(Boolean).join(" ")
          )
        );
      });

      child.stdin.write(`${token}\n`);
      child.stdin.end();
    });
  }

  private scheduleRefresh(expiresAtMs: number): void {
    if (this.source !== "github_app") {
      return;
    }

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    const delay = Math.max(expiresAtMs - Date.now() - TOKEN_REFRESH_BUFFER_MS, TOKEN_REFRESH_RETRY_MS);
    this.refreshTimer = setTimeout(() => {
      void this.refreshAuthentication().catch((error) => {
        this.logger.error({ error }, "Failed to refresh GitHub App auth; retrying soon");
        this.scheduleRefresh(Date.now() + TOKEN_REFRESH_RETRY_MS + TOKEN_REFRESH_BUFFER_MS);
      });
    }, delay);
    this.refreshTimer.unref?.();
  }

  private resolveGitIdentity(): GitIdentity | null {
    if (this.config.gitUserName && this.config.gitUserEmail) {
      return {
        userName: this.config.gitUserName,
        userEmail: this.config.gitUserEmail
      };
    }

    if (this.source !== "github_app" || !this.config.githubAppId || !this.appSlug) {
      return null;
    }

    return deriveGitHubAppIdentity(this.config.githubAppId, this.appSlug);
  }
}

let gitHubAuthManager: GitHubAuthManager | null = null;

async function configureRepositoryCredentialHelper(localPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  await execFileAsync("git", ["-C", localPath, "config", "credential.helper", "!gh auth git-credential"], {
    env,
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  });
  await execFileAsync("git", ["-C", localPath, "config", "credential.useHttpPath", "true"], {
    env,
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  });
}

export async function initializeGitHubAuth(config: AppConfig, logger: Logger): Promise<void> {
  gitHubAuthManager = new GitHubAuthManager(config, logger);
  await gitHubAuthManager.initialize();
}

export function getGitHubCommandEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!gitHubAuthManager) {
    return {
      ...baseEnv,
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0"
    };
  }

  return gitHubAuthManager.getCommandEnvironment(baseEnv);
}

export async function ensureGitHubCliAuthenticated(): Promise<void> {
  await gitHubAuthManager?.ensureReady();
}

export async function configureRepositoryGitAuth(localPath: string): Promise<void> {
  if (!gitHubAuthManager) {
    await configureRepositoryCredentialHelper(localPath, getGitHubCommandEnvironment());
    return;
  }

  await gitHubAuthManager.configureRepository(localPath);
}
