import { mkdirSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
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
    | "DIFF_FAILED"
    | "PUSH_FAILED"
    | "AUTO_COMMIT_FAILED";

  public constructor(
    code:
      | "GIT_UNAVAILABLE"
      | "CLONE_FAILED"
      | "MASTER_BRANCH_MISSING"
      | "CHECKOUT_FAILED"
      | "CLEANUP_FAILED"
      | "DIFF_FAILED"
      | "PUSH_FAILED"
      | "AUTO_COMMIT_FAILED",
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

async function runGitNoIndexDiffWithOverflowFallback(args: string[], cwd: string): Promise<string> {
  try {
    const result = await runGitWithOutput(args, { cwd });
    return result.stdout;
  } catch (error) {
    const spawnError = error as { code?: string | number; message?: string; stdout?: string };
    if (spawnError.code === "EMSGSIZE") {
      return clipOverflowedDiff(spawnError.stdout ?? "");
    }

    if ((spawnError.stdout ?? "").length > 0 && (spawnError.code === 1 || spawnError.code === "1" || (spawnError.message ?? "").includes("code 1"))) {
      return spawnError.stdout ?? "";
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

export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  return !(await isWorktreeClean(worktreePath));
}

export async function hasUncommittedChangesExcluding(worktreePath: string, excludePaths: string[]): Promise<boolean> {
  const excludeArgs = getExcludePathspecArgs(excludePaths);
  const pathspecArgs = excludeArgs.length > 0 ? ["--", ".", ...excludeArgs] : [];
  const result = await runGitWithOutput(["status", "--porcelain", ...pathspecArgs], { cwd: worktreePath });
  return result.stdout.trim().length > 0;
}

export async function autoCommitAll(worktreePath: string, message: string, excludePaths?: string[]): Promise<boolean> {
  await runGitWithOutput(["add", "-A"], { cwd: worktreePath });

  if (excludePaths && excludePaths.length > 0) {
    for (const path of excludePaths) {
      await runGitWithOutput(["reset", "--", path], { cwd: worktreePath });
    }
  }

  try {
    await runGitWithOutput(["diff", "--cached", "--quiet"], { cwd: worktreePath });
    return false;
  } catch (error) {
    const spawnError = error as { stderr?: string };
    if (spawnError.stderr) {
      throw error;
    }
    await runGitWithOutput(["commit", "-m", message], { cwd: worktreePath });
    return true;
  }
}

const AUTO_COMMIT_MESSAGE = "review: auto-commit working tree changes";
const ARTIFACT_EXCLUDE_PATHS = ["docs/reviews/"];

export async function autoCommitDirtyWorktree(worktreePath: string): Promise<boolean> {
  try {
    if (!(await hasUncommittedChanges(worktreePath))) {
      return false;
    }

    return await autoCommitAll(worktreePath, AUTO_COMMIT_MESSAGE, ARTIFACT_EXCLUDE_PATHS);
  } catch (error) {
    if (error instanceof GitWorkspaceError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Could not auto-commit dirty worktree.";
    throw new GitWorkspaceError("AUTO_COMMIT_FAILED", message);
  }
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

export async function pushBranch(worktreePath: string, branchName: string): Promise<void> {
  try {
    await ensureGitHubCliAuthenticated();
    await runGitWithOutput(["-C", worktreePath, "push", "-u", "origin", branchName], { useCredentialHelper: true });
  } catch (error) {
    if (error instanceof GitWorkspaceError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : `Could not push branch ${branchName}.`;
    throw new GitWorkspaceError("PUSH_FAILED", message);
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
    const mergeBaseResult = await runGitWithOutput(["merge-base", defaultBranch.remoteRef, options.headRef], { cwd: repoPath });
    const comparisonRef = mergeBaseResult.stdout.trim();
    const diffOptions = options.excludePaths ? { excludePaths: options.excludePaths } : undefined;
    const [changedFiles, diffResult, headSha] = await Promise.all([
      getChangedFilesSinceRef(repoPath, comparisonRef, diffOptions),
      getDiffSinceRef(repoPath, comparisonRef, diffOptions),
      getHeadSha(repoPath, options.headRef)
    ]);

    return {
      baseBranch: defaultBranch.branchName,
      baseRef: defaultBranch.remoteRef,
      headRef: options.headRef,
      headSha,
      changedFiles,
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

function getExcludePathspecArgs(excludePaths: string[] | undefined): string[] {
  return (excludePaths ?? []).map((path) => `:(exclude)${path}`);
}

async function getUntrackedFiles(repoPath: string, excludePaths?: string[]): Promise<string[]> {
  const excludeArgs = getExcludePathspecArgs(excludePaths);
  const pathspecArgs = excludeArgs.length > 0 ? ["--", ".", ...excludeArgs] : [];
  const untrackedResult = await runGitWithOutput(["ls-files", "--others", "--exclude-standard", "-z", ...pathspecArgs], { cwd: repoPath });
  return untrackedResult.stdout
    .split("\0")
    .filter(Boolean);
}

async function getChangedFilesSinceRef(
  repoPath: string,
  baseRef: string,
  options?: { excludePaths?: string[] }
): Promise<string[]> {
  const excludeArgs = getExcludePathspecArgs(options?.excludePaths);
  const pathspecArgs = excludeArgs.length > 0 ? ["--", ".", ...excludeArgs] : [];
  const [trackedResult, untrackedFiles] = await Promise.all([
    runGitWithOutput(["diff", "--name-only", baseRef, ...pathspecArgs], { cwd: repoPath }),
    getUntrackedFiles(repoPath, options?.excludePaths)
  ]);

  return Array.from(new Set([
    ...trackedResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    ...untrackedFiles
  ]));
}

export async function getDiffSinceRef(
  repoPath: string,
  baseRef: string,
  options?: { excludePaths?: string[] }
): Promise<string> {
  try {
    const excludeArgs = getExcludePathspecArgs(options?.excludePaths);
    const pathspecArgs = excludeArgs.length > 0 ? ["--", ".", ...excludeArgs] : [];
    const [trackedDiff, untrackedResult] = await Promise.all([
      runGitDiffWithOverflowFallback(["diff", baseRef, ...pathspecArgs], repoPath),
      getUntrackedFiles(repoPath, options?.excludePaths)
    ]);

    if (untrackedResult.length === 0) {
      return trackedDiff;
    }

    const untrackedDiffs = await Promise.all(
      untrackedResult.map((path) =>
        runGitNoIndexDiffWithOverflowFallback(["diff", "--no-index", "--", "/dev/null", path], repoPath)
          .catch(() => "")
      )
    );

    return [trackedDiff.trimEnd(), ...untrackedDiffs.map((diff) => diff.trimEnd()).filter(Boolean)]
      .filter(Boolean)
      .join("\n");
  } catch (error) {
    if (error instanceof GitWorkspaceError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : `Could not compute diff since ${baseRef}.`;
    throw new GitWorkspaceError("DIFF_FAILED", message);
  }
}

export async function getCommitsSinceBaseRef(worktreePath: string, baseRef: string, logger?: Logger): Promise<string[]> {
  try {
    const result = await runGitWithOutput(["log", "--oneline", `${baseRef}..HEAD`], { cwd: worktreePath });
    return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    logger?.warn({ error, worktreePath, baseRef }, "getCommitsSinceBaseRef failed");
    return [];
  }
}

export async function getShortStatus(worktreePath: string, logger?: Logger): Promise<string> {
  try {
    const result = await runGitWithOutput(["status", "--short"], { cwd: worktreePath });
    return result.stdout.replace(/\s+$/u, "");
  } catch (error) {
    logger?.warn({ error, worktreePath }, "getShortStatus failed");
    return "";
  }
}

export async function getUnstagedDiffSummary(worktreePath: string, logger?: Logger): Promise<string> {
  try {
    const result = await runGitWithOutput(["diff"], { cwd: worktreePath });
    const trimmed = result.stdout.trim();
    if (trimmed.length > 1800) {
      return await fallbackToStatOrNames(worktreePath, logger) || "";
    }
    return trimmed;
  } catch (error) {
    logger?.warn({ error, worktreePath }, "getUnstagedDiffSummary primary diff failed — falling back to --stat/--name-only");
    const fallback = await fallbackToStatOrNames(worktreePath, logger);
    if (fallback) return fallback;
    return "";
  }
}

export async function getStagedDiffSummary(worktreePath: string, logger?: Logger): Promise<string> {
  try {
    const result = await runGitWithOutput(["diff", "--cached"], { cwd: worktreePath });
    const trimmed = result.stdout.trim();
    if (trimmed.length > 1800) {
      return await fallbackToCachedStatOrNames(worktreePath, logger) || "";
    }
    return trimmed;
  } catch (error) {
    logger?.warn({ error, worktreePath }, "getStagedDiffSummary primary diff failed — falling back to --stat/--name-only");
    const fallback = await fallbackToCachedStatOrNames(worktreePath, logger);
    if (fallback) return fallback;
    return "";
  }
}

async function fallbackToStatOrNames(worktreePath: string, logger?: Logger): Promise<string> {
  try {
    const statResult = await runGitWithOutput(["diff", "--stat"], { cwd: worktreePath });
    if (statResult.stdout.trim()) {
      return statResult.stdout.trim();
    }
  } catch (error) {
    logger?.warn({ error, worktreePath }, "fallbackToStatOrNames --stat failed");
  }
  try {
    const nameResult = await runGitWithOutput(["diff", "--name-only"], { cwd: worktreePath });
    return nameResult.stdout.trim() || "";
  } catch (error) {
    logger?.warn({ error, worktreePath }, "fallbackToStatOrNames --name-only failed");
    return "";
  }
}

async function fallbackToCachedStatOrNames(worktreePath: string, logger?: Logger): Promise<string> {
  try {
    const statResult = await runGitWithOutput(["diff", "--cached", "--stat"], { cwd: worktreePath });
    if (statResult.stdout.trim()) {
      return statResult.stdout.trim();
    }
  } catch (error) {
    logger?.warn({ error, worktreePath }, "fallbackToCachedStatOrNames --cached --stat failed");
  }
  try {
    const nameResult = await runGitWithOutput(["diff", "--cached", "--name-only"], { cwd: worktreePath });
    return nameResult.stdout.trim() || "";
  } catch (error) {
    logger?.warn({ error, worktreePath }, "fallbackToCachedStatOrNames --cached --name-only failed");
    return "";
  }
}

export async function getDefaultBranchBaseRef(worktreePath: string, logger?: Logger): Promise<string> {
  try {
    const defaultBranch = await detectDefaultBranch(worktreePath);
    return defaultBranch.remoteRef;
  } catch (error) {
    logger?.warn({ error, worktreePath }, "getDefaultBranchBaseRef failed");
    return "";
  }
}
