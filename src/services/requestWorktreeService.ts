import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { configureRepositoryGitAuth } from "./githubAuthService.js";
import { buildRepoCheckoutPath, type RepoIdentity } from "./gitWorkspaceService.js";

const execFileAsync = promisify(execFile);

export interface RequestWorktreeHandle {
  branchName: string | null;
  path: string;
}

export class RequestWorktreeError extends Error {
  public readonly code: "CREATE_FAILED" | "CLEANUP_FAILED" | "DELETE_FAILED" | "GIT_UNAVAILABLE";

  public constructor(code: "CREATE_FAILED" | "CLEANUP_FAILED" | "DELETE_FAILED" | "GIT_UNAVAILABLE", message: string) {
    super(message);
    this.name = "RequestWorktreeError";
    this.code = code;
  }
}

function sanitizePathPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_");
}

export function buildRequestWorktreePath(
  reposRootPath: string,
  repoIdentity: RepoIdentity,
  requestId: number
): string {
  return join(
    reposRootPath,
    ".worktrees",
    sanitizePathPart(repoIdentity.owner),
    sanitizePathPart(repoIdentity.repo),
    String(requestId)
  );
}

export function buildRequestWorktreeBranchName(requestId: number): string {
  return `ask/${requestId}-${Date.now()}`;
}

async function runGit(args: string[]): Promise<void> {
  try {
    await execFileAsync("git", args, {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Git command failed.";
    if (message.includes("ENOENT")) {
      throw new RequestWorktreeError("GIT_UNAVAILABLE", "Git is not installed or not available in PATH.");
    }
    throw error;
  }
}

function describeGitError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isMissingWorktreeError(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes("is not a working tree")
    || lowered.includes("no such file or directory")
    || lowered.includes("cannot find the file")
    || lowered.includes("does not exist");
}

function isMissingBranchError(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes("branch") && lowered.includes("not found");
}

export async function createRequestWorktree(
  reposRootPath: string,
  repoIdentity: RepoIdentity,
  requestId: number,
  options?: { detached?: boolean }
): Promise<RequestWorktreeHandle> {
  const worktreePath = buildRequestWorktreePath(reposRootPath, repoIdentity, requestId);
  const branchName = options?.detached ? null : buildRequestWorktreeBranchName(requestId);
  const baseCheckoutPath = buildRepoCheckoutPath(reposRootPath, repoIdentity.owner, repoIdentity.repo);

  mkdirSync(join(worktreePath, ".."), { recursive: true });

  try {
    await runGit(["-C", baseCheckoutPath, "worktree", "prune"]);
    const addArgs = ["-C", baseCheckoutPath, "worktree", "add"];
    if (branchName) {
      addArgs.push("-B", branchName, worktreePath, "master");
    } else {
      addArgs.push("--detach", worktreePath, "master");
    }
    await runGit(addArgs);
    await configureRepositoryGitAuth(worktreePath);
    return {
      branchName,
      path: worktreePath
    };
  } catch (error) {
    if (error instanceof RequestWorktreeError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Failed to create request worktree.";
    throw new RequestWorktreeError("CREATE_FAILED", message);
  }
}

export async function cleanupRequestWorktree(
  reposRootPath: string,
  repoIdentity: RepoIdentity,
  worktreePath: string
): Promise<void> {
  const baseCheckoutPath = buildRepoCheckoutPath(reposRootPath, repoIdentity.owner, repoIdentity.repo);
  let removeFailure: unknown = null;
  let pruneFailure: unknown = null;

  try {
    await runGit(["-C", baseCheckoutPath, "worktree", "remove", "--force", worktreePath]);
  } catch (error) {
    removeFailure = error;
  }

  try {
    await runGit(["-C", baseCheckoutPath, "worktree", "prune"]);
  } catch (error) {
    pruneFailure = error;
  }

  if (!removeFailure && !pruneFailure) {
    return;
  }

  const parts: string[] = [];
  if (removeFailure) {
    const message = removeFailure instanceof Error ? removeFailure.message : "Failed to remove request worktree.";
    parts.push(`remove: ${message}`);
  }
  if (pruneFailure) {
    const message = pruneFailure instanceof Error ? pruneFailure.message : "Failed to prune request worktrees.";
    parts.push(`prune: ${message}`);
  }
  throw new RequestWorktreeError("CLEANUP_FAILED", parts.join(" | "));
}

export async function deleteRequestBranch(
  reposRootPath: string,
  repoIdentity: RepoIdentity,
  options: {
    branchName: string;
    worktreePath?: string | null;
  }
): Promise<void> {
  const baseCheckoutPath = buildRepoCheckoutPath(reposRootPath, repoIdentity.owner, repoIdentity.repo);

  if (options.worktreePath) {
    try {
      await cleanupRequestWorktree(reposRootPath, repoIdentity, options.worktreePath);
    } catch (error) {
      const message = describeGitError(error, "Failed to remove request worktree.");
      if (!isMissingWorktreeError(message)) {
        throw new RequestWorktreeError("DELETE_FAILED", `Could not remove request worktree: ${message}`);
      }
    }
  }

  try {
    await runGit(["-C", baseCheckoutPath, "branch", "-D", options.branchName]);
  } catch (error) {
    if (error instanceof RequestWorktreeError) {
      throw error;
    }

    const message = describeGitError(error, "Failed to delete request branch.");
    if (isMissingBranchError(message)) {
      return;
    }

    throw new RequestWorktreeError("DELETE_FAILED", message);
  }
}
