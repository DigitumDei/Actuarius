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
    | "CHECKOUT_FAILED"
    | "CLEANUP_FAILED"
    | "DIFF_FAILED";

  public constructor(
    code: "GIT_UNAVAILABLE" | "CLONE_FAILED" | "MASTER_BRANCH_MISSING" | "CHECKOUT_FAILED" | "CLEANUP_FAILED" | "DIFF_FAILED",
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

export interface CleanupDeletedBranchesResult {
  deleted: string[];
  removedWorktrees: string[];
  skippedDirtyWorktrees: Array<{ branchName: string; path: string }>;
}

export interface ReviewDiffResult {
  baseBranch: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  changedFiles: string[];
  diffText: string;
}

interface GitWorktreeEntry {
  branchName: string | null;
  path: string;
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
  options?: { cwd?: string; useCredentialHelper?: boolean; maxBuffer?: number }
): Promise<{ stdout: string; stderr: string }> {
  try {
    const gitArgs = options?.useCredentialHelper
      ? ["-c", "credential.helper=!gh auth git-credential", "-c", "credential.useHttpPath=true", ...args]
      : args;

    return await spawnCollect("git", gitArgs, {
      cwd: options?.cwd ?? process.cwd(),
      env: getGitHubCommandEnvironment(),
      timeoutMs: 60_000,
      maxBuffer: options?.maxBuffer ?? 4 * 1024 * 1024
    });
  } catch (error) {
    const spawnError = error as { message?: string; stdout?: string; stderr?: string; code?: string };
    const message = spawnError.message ?? "Git command failed.";
    const stderr = spawnError.stderr ?? "";
    if (message.includes("ENOENT") || spawnError.code === "ENOENT") {
      throw new GitWorkspaceError("GIT_UNAVAILABLE", "Git is not installed or not available in PATH.");
    }

    const fullMessage = stderr ? `${message}\n${stderr}`.trim() : message;
    const enriched = new Error(fullMessage);
    Object.assign(enriched, { stdout: spawnError.stdout ?? "", stderr, code: spawnError.code });
    throw enriched;
  }
}

function clipOverflowedDiff(stdout: string): string {
  const trimmed = stdout.trimEnd();
  if (trimmed.length === 0) {
    return "";
  }

  return `${trimmed}\n...(truncated after git diff exceeded maxBuffer)`;
}

async function runGitDiffWithOverflowFallback(args: string[], cwd: string): Promise<string> {
  try {
    const result = await runGitWithOutput(args, { cwd });
    return result.stdout;
  } catch (error) {
    const spawnError = error as { code?: string; stdout?: string };
    if (spawnError.code === "EMSGSIZE") {
      return clipOverflowedDiff(spawnError.stdout ?? "");
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

export async function cleanupDeletedRemoteBranches(repoPath: string): Promise<CleanupDeletedBranchesResult> {
  try {
    await runGit(["-C", repoPath, "fetch", "origin", "--prune"], { useCredentialHelper: true });
    await runGit(["-C", repoPath, "worktree", "prune"]);

    const refs = await runGitWithOutput(
      ["for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)", "refs/heads"],
      { cwd: repoPath }
    );
    const worktrees = await listWorktrees(repoPath);
    const worktreesByBranch = new Map<string, GitWorktreeEntry>();
    for (const worktree of worktrees) {
      if (!worktree.branchName) {
        continue;
      }
      worktreesByBranch.set(worktree.branchName, worktree);
    }

    const deleted: string[] = [];
    const removedWorktrees: string[] = [];
    const skippedDirtyWorktrees: Array<{ branchName: string; path: string }> = [];
    for (const line of refs.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
      const [branchName = "", upstream = "", track = ""] = line.split("\t");
      if (!branchName || !upstream.startsWith("origin/") || !track.includes("[gone]")) {
        continue;
      }

      const worktree = worktreesByBranch.get(branchName);
      if (worktree) {
        const isClean = await isWorktreeClean(worktree.path);
        if (!isClean) {
          skippedDirtyWorktrees.push({ branchName, path: worktree.path });
          continue;
        }

        await runGit(["-C", repoPath, "worktree", "remove", worktree.path]);
        removedWorktrees.push(worktree.path);
      }

      await runGit(["-C", repoPath, "branch", "-D", branchName]);
      deleted.push(branchName);
    }

    deleted.sort((a, b) => a.localeCompare(b));
    removedWorktrees.sort((a, b) => a.localeCompare(b));
    skippedDirtyWorktrees.sort((a, b) => a.branchName.localeCompare(b.branchName) || a.path.localeCompare(b.path));
    return { deleted, removedWorktrees, skippedDirtyWorktrees };
  } catch (error) {
    if (error instanceof GitWorkspaceError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Could not clean deleted remote branches.";
    throw new GitWorkspaceError("CLEANUP_FAILED", message);
  }
}

async function listWorktrees(repoPath: string): Promise<GitWorktreeEntry[]> {
  const result = await runGitWithOutput(["worktree", "list", "--porcelain"], { cwd: repoPath });
  const entries: GitWorktreeEntry[] = [];
  let currentPath: string | null = null;
  let currentBranchName: string | null = null;

  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      if (currentPath) {
        entries.push({ path: currentPath, branchName: currentBranchName });
      }
      currentPath = null;
      currentBranchName = null;
      continue;
    }

    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
      continue;
    }

    if (line.startsWith("branch refs/heads/")) {
      currentBranchName = line.slice("branch refs/heads/".length);
    }
  }

  if (currentPath) {
    entries.push({ path: currentPath, branchName: currentBranchName });
  }

  return entries;
}

async function isWorktreeClean(worktreePath: string): Promise<boolean> {
  const result = await runGitWithOutput(["status", "--porcelain"], { cwd: worktreePath });
  return result.stdout.trim().length === 0;
}

export async function detectDefaultBranch(repoPath: string): Promise<{ branchName: string; remoteRef: string }> {
  const candidates = ["main", "master"] as const;

  try {
    const symbolicRef = await runGitWithOutput(["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: repoPath });
    const ref = symbolicRef.stdout.trim();
    const prefix = "refs/remotes/origin/";
    if (ref.startsWith(prefix)) {
      const branchName = ref.slice(prefix.length);
      if (branchName) {
        return { branchName, remoteRef: `origin/${branchName}` };
      }
    }
  } catch {
    // Fall back to probing the common default branches below.
  }

  for (const branchName of candidates) {
    try {
      await runGitWithOutput(["rev-parse", "--verify", `refs/remotes/origin/${branchName}`], { cwd: repoPath });
      return { branchName, remoteRef: `origin/${branchName}` };
    } catch {
      // Probe the next candidate.
    }
  }

  throw new GitWorkspaceError("MASTER_BRANCH_MISSING", "Could not determine the repository default branch from origin/main or origin/master.");
}

export async function getHeadSha(repoPath: string, ref: string = "HEAD"): Promise<string> {
  try {
    const result = await runGitWithOutput(["rev-parse", ref], { cwd: repoPath });
    return result.stdout.trim();
  } catch (error) {
    if (error instanceof GitWorkspaceError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : `Could not resolve git ref ${ref}.`;
    throw new GitWorkspaceError("DIFF_FAILED", message);
  }
}

export async function getReviewDiff(
  repoPath: string,
  options: {
    headRef: string;
    excludePaths?: string[];
  }
): Promise<ReviewDiffResult> {
  try {
    const defaultBranch = await detectDefaultBranch(repoPath);
    const excludeArgs = (options.excludePaths ?? []).map((path) => `:(exclude)${path}`);
    const diffArgs = ["--merge-base", defaultBranch.remoteRef, options.headRef, "--", ...excludeArgs];
    const [changedFilesResult, diffResult, headSha] = await Promise.all([
      runGitWithOutput(["diff", "--name-only", ...diffArgs], { cwd: repoPath }),
      runGitDiffWithOverflowFallback(["diff", ...diffArgs], repoPath),
      getHeadSha(repoPath, options.headRef)
    ]);

    return {
      baseBranch: defaultBranch.branchName,
      baseRef: defaultBranch.remoteRef,
      headRef: options.headRef,
      headSha,
      changedFiles: changedFilesResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      diffText: diffResult
    };
  } catch (error) {
    if (error instanceof GitWorkspaceError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Could not compute review diff.";
    throw new GitWorkspaceError("DIFF_FAILED", message);
  }
}
