import { mkdirSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

async function runGit(args: string[]): Promise<void> {
  try {
    await execFileAsync("git", args, {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Git command failed.";
    if (message.includes("ENOENT")) {
      throw new GitWorkspaceError("GIT_UNAVAILABLE", "Git is not installed or not available in PATH.");
    }
    throw error;
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
  const localPath = buildRepoCheckoutPath(reposRootPath, repoIdentity.owner, repoIdentity.repo);
  const localGitDirectory = join(localPath, ".git");
  const ownerDirectory = join(reposRootPath, sanitizePathPart(repoIdentity.owner));
  const remoteUrl = `https://github.com/${repoIdentity.owner}/${repoIdentity.repo}.git`;

  mkdirSync(ownerDirectory, { recursive: true });

  const hasExistingCheckout = await pathExists(localGitDirectory);
  if (!hasExistingCheckout) {
    try {
      await runGit(["clone", remoteUrl, localPath]);
    } catch (error) {
      if (error instanceof GitWorkspaceError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Repository clone failed.";
      throw new GitWorkspaceError("CLONE_FAILED", message);
    }
  }

  let checkoutSourceRef = "origin/master";
  try {
    await runGit(["-C", localPath, "remote", "set-url", "origin", remoteUrl]);
    await runGit(["-C", localPath, "fetch", "origin", "master", "--prune"]);
  } catch (error) {
    if (error instanceof GitWorkspaceError) {
      throw error;
    }

    const masterFetchMessage = error instanceof Error ? error.message : "Could not fetch origin/master.";
    if (!isMissingRemoteRefError(masterFetchMessage)) {
      throw new GitWorkspaceError("CHECKOUT_FAILED", masterFetchMessage);
    }

    try {
      await runGit(["-C", localPath, "fetch", "origin", "main", "--prune"]);
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
}
