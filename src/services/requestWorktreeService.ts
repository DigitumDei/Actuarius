import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildRepoCheckoutPath, type RepoIdentity } from "./gitWorkspaceService.js";

const execFileAsync = promisify(execFile);

export interface RequestWorktreeHandle {
  branchName: string;
  path: string;
}

export class RequestWorktreeError extends Error {
  public readonly code: "CREATE_FAILED" | "CLEANUP_FAILED" | "GIT_UNAVAILABLE";

  public constructor(code: "CREATE_FAILED" | "CLEANUP_FAILED" | "GIT_UNAVAILABLE", message: string) {
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

export async function createRequestWorktree(
  reposRootPath: string,
  repoIdentity: RepoIdentity,
  requestId: number
): Promise<RequestWorktreeHandle> {
  const worktreePath = buildRequestWorktreePath(reposRootPath, repoIdentity, requestId);
  const branchName = buildRequestWorktreeBranchName(requestId);
  const baseCheckoutPath = buildRepoCheckoutPath(reposRootPath, repoIdentity.owner, repoIdentity.repo);

  mkdirSync(join(worktreePath, ".."), { recursive: true });

  try {
    await runGit(["-C", baseCheckoutPath, "worktree", "add", "-B", branchName, worktreePath, "master"]);
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

  try {
    await runGit(["-C", baseCheckoutPath, "worktree", "remove", "--force", worktreePath]);
    await runGit(["-C", baseCheckoutPath, "worktree", "prune"]);
  } catch (error) {
    if (error instanceof RequestWorktreeError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Failed to cleanup request worktree.";
    throw new RequestWorktreeError("CLEANUP_FAILED", message);
  }
}

