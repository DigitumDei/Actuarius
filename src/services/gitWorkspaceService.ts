import { mkdirSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import {
  configureRepositoryGitAuth,
  ensureGitHubCliAuthenticated,
  getGitHubCommandEnvironment
} from "./githubAuthService.js";
import { spawnCollect } from "../utils/spawnCollect.js";

const repoLocks = new Map<string, Promise<void>>();

export interface RepoIdentity {
  owner: string;
  repo: string;
  fullName: string;
}

export class GitWorkspaceError extends Error {
  public readonly code:
    | "GIT_UNAVAILABLE"
    | "CLONE_FAILED"
    | "MASTER_BRANCH_MISSING"
    | "CHECKOUT_FAILED";

  public constructor(
    code: "GIT_UNAVAILABLE" | "CLONE_FAILED" | "MASTER_BRANCH_MISSING" | "CHECKOUT_FAILED",
    message: string
  ) {
    super(message);
    this.name = "GitWorkspaceError";
    this.code = code;
  }
}

export interface RepoBranches {
  local: string[];
  remote: string[];
}

function sanitizePathPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_");
}

export function buildRepoCheckoutPath(reposRootPath: string, owner: string, repo: string): string {
  return join(reposRootPath, sanitizePathPart(owner), sanitizePathPart(repo));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runGit(args: string[], options?: { useCredentialHelper?: boolean }): Promise<void> {
  try {
    const gitArgs = options?.useCredentialHelper
      ? ["-c", "credential.helper=!gh auth git-credential", "-c", "credential.useHttpPath=true", ...args]
      : args;

    await spawnCollect("git", gitArgs, {
      cwd: process.cwd(),
      env: getGitHubCommandEnvironment(),
      timeoutMs: 60_000,
      maxBuffer: 4 * 1024 * 1024
    });
  } catch (error) {
    const spawnError = error as { message?: string; stderr?: string; code?: string };
    const message = spawnError.message ?? "Git command failed.";
    const stderr = spawnError.stderr ?? "";
    if (message.includes("ENOENT") || spawnError.code === "ENOENT") {
      throw new GitWorkspaceError("GIT_UNAVAILABLE", "Git is not installed or not available in PATH.");
    }
    // Attach stderr to message so callers can inspect the full git error
    const fullMessage = stderr ? `${message}\n${stderr}`.trim() : message;
    const enriched = new Error(fullMessage);
    Object.assign(enriched, { stderr, code: spawnError.code });
    throw enriched;
  }
}

async function runGitWithOutput(
  args: string[],
  options?: { cwd?: string; useCredentialHelper?: boolean }
): Promise<{ stdout: string; stderr: string }> {
  try {
    const gitArgs = options?.useCredentialHelper
      ? ["-c", "credential.helper=!gh auth git-credential", "-c", "credential.useHttpPath=true", ...args]
      : args;

    return await spawnCollect("git", gitArgs, {
      cwd: options?.cwd ?? process.cwd(),
      env: getGitHubCommandEnvironment(),
      timeoutMs: 60_000,
      maxBuffer: 4 * 1024 * 1024
    });
  } catch (error) {
    const spawnError = error as { message?: string; stderr?: string; code?: string };
    const message = spawnError.message ?? "Git command failed.";
    const stderr = spawnError.stderr ?? "";
    if (message.includes("ENOENT") || spawnError.code === "ENOENT") {
      throw new GitWorkspaceError("GIT_UNAVAILABLE", "Git is not installed or not available in PATH.");
    }

    const fullMessage = stderr ? `${message}\n${stderr}`.trim() : message;
    const enriched = new Error(fullMessage);
    Object.assign(enriched, { stderr, code: spawnError.code });
    throw enriched;
  }
}

function isMissingRemoteRefError(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes("couldn't find remote ref") || lowered.includes("remote ref does not exist");
}

export async function ensureRepoCheckedOutToMaster(
  reposRootPath: string,
  repoIdentity: RepoIdentity
): Promise<{ localPath: string }> {
  await ensureGitHubCliAuthenticated();

  const localPath = buildRepoCheckoutPath(reposRootPath, repoIdentity.owner, repoIdentity.repo);
  const localGitDirectory = join(localPath, ".git");
  const ownerDirectory = join(reposRootPath, sanitizePathPart(repoIdentity.owner));
  const remoteUrl = `https://github.com/${repoIdentity.owner}/${repoIdentity.repo}.git`;

  const previousLock = repoLocks.get(localPath) ?? Promise.resolve();
  let releaseLock: () => void = () => undefined;
  const currentLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const lockTail = previousLock.then(() => currentLock);
  repoLocks.set(localPath, lockTail);

  await previousLock;

  try {
    mkdirSync(ownerDirectory, { recursive: true });

    const hasExistingCheckout = await pathExists(localGitDirectory);
    if (!hasExistingCheckout) {
      try {
        await runGit(["clone", remoteUrl, localPath], { useCredentialHelper: true });
      } catch (error) {
        if (error instanceof GitWorkspaceError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : "Repository clone failed.";
        throw new GitWorkspaceError("CLONE_FAILED", message);
      }
    }

    try {
      await configureRepositoryGitAuth(localPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not configure repository git authentication.";
      throw new GitWorkspaceError("CHECKOUT_FAILED", message);
    }

    let checkoutSourceRef = "origin/master";
    try {
      await runGit(["-C", localPath, "remote", "set-url", "origin", remoteUrl]);
      await runGit(["-C", localPath, "fetch", "origin", "master", "--prune"], { useCredentialHelper: true });
    } catch (error) {
      if (error instanceof GitWorkspaceError) {
        throw error;
      }

      const masterFetchMessage = error instanceof Error ? error.message : "Could not fetch origin/master.";
      if (!isMissingRemoteRefError(masterFetchMessage)) {
        throw new GitWorkspaceError("CHECKOUT_FAILED", masterFetchMessage);
      }

      try {
        await runGit(["-C", localPath, "fetch", "origin", "main", "--prune"], { useCredentialHelper: true });
        checkoutSourceRef = "origin/main";
      } catch (mainError) {
        if (mainError instanceof GitWorkspaceError) {
          throw mainError;
        }

        const mainFetchMessage = mainError instanceof Error ? mainError.message : "Could not fetch origin/main.";
        if (isMissingRemoteRefError(mainFetchMessage)) {
          throw new GitWorkspaceError(
            "MASTER_BRANCH_MISSING",
            `Could not fetch origin/master or origin/main for ${repoIdentity.fullName}.`
          );
        }

        throw new GitWorkspaceError("CHECKOUT_FAILED", mainFetchMessage);
      }
    }

    try {
      await runGit(["-C", localPath, "checkout", "-B", "master", checkoutSourceRef]);
    } catch (error) {
      if (error instanceof GitWorkspaceError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Could not checkout master branch.";
      throw new GitWorkspaceError("CHECKOUT_FAILED", message);
    }

    return {
      localPath
    };
  } finally {
    releaseLock();
    if (repoLocks.get(localPath) === lockTail) {
      repoLocks.delete(localPath);
    }
  }
}

export async function listBranches(repoPath: string): Promise<RepoBranches> {
  try {
    const [localResult, remoteResult] = await Promise.all([
      runGitWithOutput(["branch", "--format=%(refname:short)"], { cwd: repoPath }),
      runGitWithOutput(["ls-remote", "--heads", "origin"], { cwd: repoPath, useCredentialHelper: true })
    ]);

    const local = localResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort((a, b) => a.localeCompare(b));

    const remote = remoteResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const ref = line.split(/\s+/u)[1] ?? "";
        return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      })
      .filter((line) => line.length > 0)
      .sort((a, b) => a.localeCompare(b));

    return { local, remote };
  } catch (error) {
    if (error instanceof GitWorkspaceError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Could not list repository branches.";
    throw new GitWorkspaceError("CHECKOUT_FAILED", message);
  }
}
