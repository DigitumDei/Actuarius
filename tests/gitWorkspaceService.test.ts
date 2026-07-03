import { beforeEach, describe, expect, it, vi } from "vitest";
import type pino from "pino";

vi.mock("../src/utils/spawnCollect.js");
vi.mock("../src/services/githubAuthService.js", () => ({
  configureRepositoryGitAuth: vi.fn().mockResolvedValue(undefined),
  ensureGitHubCliAuthenticated: vi.fn().mockResolvedValue(undefined),
  getGitHubCommandEnvironment: vi.fn(() => process.env)
}));

const { spawnCollect } = await import("../src/utils/spawnCollect.js");
const mockSpawnCollect = vi.mocked(spawnCollect);

const {
  autoCommitAll,
  autoCommitDirtyWorktree,
  buildRepoCheckoutPath,
  cleanupDeletedRemoteBranches,
  detectDefaultBranch,
  GitWorkspaceError,
  getCommitsSinceBaseRef,
  getDefaultBranchBaseRef,
  getDiffSinceRef,
  getHeadSha,
  getReviewDiff,
  getShortStatus,
  getStagedDiffSummary,
  getUnstagedDiffSummary,
  hasUncommittedChanges,
  listBranches,
  pushBranch
} = await import("../src/services/gitWorkspaceService.js");

describe("gitWorkspaceService", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("builds a deterministic lowercase path", () => {
    const path = buildRepoCheckoutPath("/data/repos", "DigitumDei", "Actuarius").replaceAll("\\", "/");
    expect(path.endsWith("digitumdei/actuarius")).toBe(true);
  });

  it("sanitizes invalid path characters", () => {
    const path = buildRepoCheckoutPath("/data/repos", "My Org", "repo:name").replaceAll("\\", "/");
    expect(path.endsWith("my_org/repo_name")).toBe(true);
  });

  it("lists sorted local and remote branches", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "master\nfeature/zeta\nfeature/alpha\n", stderr: "" })
      .mockResolvedValueOnce({
        stdout: "hash1\trefs/heads/main\nhash2\trefs/heads/release/1.0\n",
        stderr: ""
      });

    await expect(listBranches("/tmp/repo")).resolves.toEqual({
      local: ["feature/alpha", "feature/zeta", "master"],
      remote: ["main", "release/1.0"]
    });
  });

  it("maps git ENOENT into a GitWorkspaceError", async () => {
    const error = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    mockSpawnCollect.mockRejectedValueOnce(error);

    await expect(listBranches("/tmp/repo")).rejects.toMatchObject({
      code: "GIT_UNAVAILABLE",
      name: "GitWorkspaceError"
    } satisfies Partial<GitWorkspaceError>);
  });

  it("deletes local branches whose origin upstream is gone", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        stdout: [
          "feature/stale\torigin/feature/stale\t[gone]",
          "feature/live\torigin/feature/live\t[ahead 1]",
          "master\torigin/master\t"
        ].join("\n"),
        stderr: ""
      })
      .mockResolvedValueOnce({
        stdout: ["worktree /tmp/repo", "HEAD abc123", "branch refs/heads/master", "", "worktree /tmp/worktree-1", "HEAD def456", "branch refs/heads/feature/stale", ""].join("\n"),
        stderr: ""
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(cleanupDeletedRemoteBranches("/tmp/repo")).resolves.toEqual({
      deleted: ["feature/stale"],
      removedWorktrees: ["/tmp/worktree-1"],
      skippedDirtyWorktrees: []
    });

    expect(mockSpawnCollect).toHaveBeenNthCalledWith(
      6,
      "git",
      ["-C", "/tmp/repo", "worktree", "remove", "/tmp/worktree-1"],
      expect.any(Object)
    );

    expect(mockSpawnCollect).toHaveBeenNthCalledWith(
      7,
      "git",
      ["-C", "/tmp/repo", "branch", "-D", "feature/stale"],
      expect.any(Object)
    );
  });

  it("skips dirty worktrees for gone upstream branches", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        stdout: "feature/stale\torigin/feature/stale\t[gone]",
        stderr: ""
      })
      .mockResolvedValueOnce({
        stdout: ["worktree /tmp/repo", "HEAD abc123", "branch refs/heads/master", "", "worktree /tmp/worktree-1", "HEAD def456", "branch refs/heads/feature/stale", ""].join("\n"),
        stderr: ""
      })
      .mockResolvedValueOnce({ stdout: " M src/index.ts\n", stderr: "" });

    await expect(cleanupDeletedRemoteBranches("/tmp/repo")).resolves.toEqual({
      deleted: [],
      removedWorktrees: [],
      skippedDirtyWorktrees: [{ branchName: "feature/stale", path: "/tmp/worktree-1" }]
    });
  });

  it("detects the default branch from origin/HEAD", async () => {
    mockSpawnCollect.mockResolvedValueOnce({
      stdout: "refs/remotes/origin/main\n",
      stderr: ""
    });

    await expect(detectDefaultBranch("/tmp/repo")).resolves.toEqual({
      branchName: "main",
      remoteRef: "origin/main"
    });
  });

  it("computes review diff and excludes review artifacts", async () => {
    mockSpawnCollect
      .mockRejectedValueOnce(new Error("no origin head"))
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "mergebase123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "src/index.ts\ndocs/guide.md\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "diff --git a/src/index.ts b/src/index.ts\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "deadbeef\n", stderr: "" });

    await expect(
      getReviewDiff("/tmp/repo", {
        headRef: "ask/1-123",
        excludePaths: ["docs/reviews/**"]
      })
    ).resolves.toEqual({
      baseBranch: "main",
      baseRef: "origin/main",
      headRef: "ask/1-123",
      headSha: "deadbeef",
      changedFiles: ["src/index.ts", "docs/guide.md"],
      diffText: "diff --git a/src/index.ts b/src/index.ts\n"
    });

    expect(mockSpawnCollect).toHaveBeenNthCalledWith(
      4,
      "git",
      ["diff", "--name-only", "mergebase123", "--", ".", ":(exclude)docs/reviews/**"],
      expect.any(Object)
    );
  });

  it("computes review diff from merge-base to the working tree and includes untracked files", async () => {
    mockSpawnCollect
      .mockRejectedValueOnce(new Error("no origin head"))
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "mergebase123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "src/index.ts\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "src/new.ts\0", stderr: "" })
      .mockResolvedValueOnce({ stdout: "diff --git a/src/index.ts b/src/index.ts\n+tracked", stderr: "" })
      .mockResolvedValueOnce({ stdout: "src/new.ts\0", stderr: "" })
      .mockResolvedValueOnce({ stdout: "deadbeef\n", stderr: "" })
      .mockRejectedValueOnce(Object.assign(new Error("Process exited with code 1"), {
        code: 1,
        stdout: "diff --git a/src/new.ts b/src/new.ts\n+new",
        stderr: ""
      }));

    await expect(
      getReviewDiff("/tmp/repo", {
        headRef: "ask/1-123",
        excludePaths: ["docs/reviews/**"]
      })
    ).resolves.toEqual({
      baseBranch: "main",
      baseRef: "origin/main",
      headRef: "ask/1-123",
      headSha: "deadbeef",
      changedFiles: ["src/index.ts", "src/new.ts"],
      diffText: [
        "diff --git a/src/index.ts b/src/index.ts\n+tracked",
        "diff --git a/src/new.ts b/src/new.ts\n+new"
      ].join("\n")
    });
  });

  it("falls back to a truncated diff when git diff exceeds maxBuffer", async () => {
    const overflowError = new Error("Process output exceeded maxBuffer") as Error & { code: string; stdout: string };
    overflowError.code = "EMSGSIZE";
    overflowError.stdout = "diff --git a/src/index.ts b/src/index.ts\n+very large output";

    mockSpawnCollect
      .mockRejectedValueOnce(new Error("no origin head"))
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "mergebase123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "src/index.ts\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(overflowError)
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "deadbeef\n", stderr: "" });

    await expect(
      getReviewDiff("/tmp/repo", {
        headRef: "ask/1-123",
        excludePaths: ["docs/reviews/**"]
      })
    ).resolves.toEqual({
      baseBranch: "main",
      baseRef: "origin/main",
      headRef: "ask/1-123",
      headSha: "deadbeef",
      changedFiles: ["src/index.ts"],
      diffText: "diff --git a/src/index.ts b/src/index.ts\n+very large output\n...(truncated after git diff exceeded maxBuffer)"
    });
  });

  it("resolves an arbitrary git ref to a sha", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: "feedface\n", stderr: "" });
    await expect(getHeadSha("/tmp/repo", "feature/x")).resolves.toBe("feedface");
  });

  it("returns a diff since a given ref", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "diff --git a/src/index.ts b/src/index.ts\n+new code", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(getDiffSinceRef("/tmp/repo", "abc123")).resolves.toBe("diff --git a/src/index.ts b/src/index.ts\n+new code");

    expect(mockSpawnCollect).toHaveBeenNthCalledWith(
      1,
      "git",
      ["diff", "abc123"],
      expect.objectContaining({ cwd: "/tmp/repo" })
    );
    expect(mockSpawnCollect).toHaveBeenNthCalledWith(
      2,
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      expect.objectContaining({ cwd: "/tmp/repo" })
    );
  });

  it("includes untracked files in a diff since a given ref", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "diff --git a/src/index.ts b/src/index.ts\n+tracked", stderr: "" })
      .mockResolvedValueOnce({ stdout: "src/new.ts\0tests/new.test.ts\0", stderr: "" })
      .mockRejectedValueOnce(Object.assign(new Error("Process exited with code 1"), {
        stdout: "diff --git a/src/new.ts b/src/new.ts\n+new source",
        stderr: ""
      }))
      .mockRejectedValueOnce(Object.assign(new Error("Process exited with code 1"), {
        stdout: "diff --git a/tests/new.test.ts b/tests/new.test.ts\n+new test",
        stderr: ""
      }));

    await expect(getDiffSinceRef("/tmp/repo", "abc123")).resolves.toBe([
      "diff --git a/src/index.ts b/src/index.ts\n+tracked",
      "diff --git a/src/new.ts b/src/new.ts\n+new source",
      "diff --git a/tests/new.test.ts b/tests/new.test.ts\n+new test"
    ].join("\n"));

    expect(mockSpawnCollect).toHaveBeenNthCalledWith(
      3,
      "git",
      ["diff", "--no-index", "--", "/dev/null", "src/new.ts"],
      expect.objectContaining({ cwd: "/tmp/repo" })
    );
  });

  it("returns untracked-only diffs since a given ref", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "src/new.ts\0", stderr: "" })
      .mockRejectedValueOnce(Object.assign(new Error("Process exited with code 1"), {
        code: 1,
        stdout: "diff --git a/src/new.ts b/src/new.ts\n+new source",
        stderr: ""
      }));

    await expect(getDiffSinceRef("/tmp/repo", "abc123")).resolves.toBe("diff --git a/src/new.ts b/src/new.ts\n+new source");
  });

  it("accepts string code 1 from no-index diff for untracked files", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "src/new.ts\0", stderr: "" })
      .mockRejectedValueOnce(Object.assign(new Error("git diff exited"), {
        code: "1",
        stdout: "diff --git a/src/new.ts b/src/new.ts\n+new source",
        stderr: ""
      }));

    await expect(getDiffSinceRef("/tmp/repo", "abc123")).resolves.toBe("diff --git a/src/new.ts b/src/new.ts\n+new source");
  });

  it("skips an untracked file that disappears before diffing", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "diff --git a/src/index.ts b/src/index.ts\n+tracked", stderr: "" })
      .mockResolvedValueOnce({ stdout: "src/new.ts\0src/vanished.ts\0", stderr: "" })
      .mockRejectedValueOnce(Object.assign(new Error("Process exited with code 1"), {
        code: 1,
        stdout: "diff --git a/src/new.ts b/src/new.ts\n+new source",
        stderr: ""
      }))
      .mockRejectedValueOnce(Object.assign(new Error("fatal: pathspec 'src/vanished.ts' did not match any files"), {
        code: 128,
        stdout: "",
        stderr: "fatal: pathspec 'src/vanished.ts' did not match any files"
      }));

    await expect(getDiffSinceRef("/tmp/repo", "abc123")).resolves.toBe([
      "diff --git a/src/index.ts b/src/index.ts\n+tracked",
      "diff --git a/src/new.ts b/src/new.ts\n+new source"
    ].join("\n"));
  });

  it("does not trim NUL-delimited untracked paths", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: " leading.ts\0trailing.ts \0", stderr: "" })
      .mockRejectedValueOnce(Object.assign(new Error("Process exited with code 1"), {
        code: 1,
        stdout: "diff --git a/ leading.ts b/ leading.ts\n+new source",
        stderr: ""
      }))
      .mockRejectedValueOnce(Object.assign(new Error("Process exited with code 1"), {
        code: 1,
        stdout: "diff --git a/trailing.ts  b/trailing.ts \n+new source",
        stderr: ""
      }));

    await getDiffSinceRef("/tmp/repo", "abc123");

    expect(mockSpawnCollect).toHaveBeenNthCalledWith(
      3,
      "git",
      ["diff", "--no-index", "--", "/dev/null", " leading.ts"],
      expect.objectContaining({ cwd: "/tmp/repo" })
    );
    expect(mockSpawnCollect).toHaveBeenNthCalledWith(
      4,
      "git",
      ["diff", "--no-index", "--", "/dev/null", "trailing.ts "],
      expect.objectContaining({ cwd: "/tmp/repo" })
    );
  });

  it("falls back to truncated diff for EMSGSIZE in getDiffSinceRef", async () => {
    const overflowError = new Error("Process output exceeded maxBuffer") as Error & { code: string; stdout: string };
    overflowError.code = "EMSGSIZE";
    overflowError.stdout = "diff --git a/src/index.ts b/src/index.ts\n+very large output";

    mockSpawnCollect
      .mockRejectedValueOnce(overflowError)
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(getDiffSinceRef("/tmp/repo", "abc123")).resolves.toBe(
      "diff --git a/src/index.ts b/src/index.ts\n+very large output\n...(truncated after git diff exceeded maxBuffer)"
    );
  });

  it("maps git ENOENT to GitWorkspaceError in getDiffSinceRef", async () => {
    const error = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    mockSpawnCollect
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(getDiffSinceRef("/tmp/repo", "abc123")).rejects.toMatchObject({
      code: "GIT_UNAVAILABLE",
      name: "GitWorkspaceError"
    } satisfies Partial<GitWorkspaceError>);
  });

  it("detects uncommitted worktree changes", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: " M src/index.ts\n", stderr: "" });

    await expect(hasUncommittedChanges("/tmp/repo")).resolves.toBe(true);
  });

  it("reports no uncommitted changes for a clean worktree", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(hasUncommittedChanges("/tmp/repo")).resolves.toBe(false);
  });

  it("pushes a request branch with GitHub credential helper", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(pushBranch("/tmp/worktree", "ask/1-123")).resolves.toBeUndefined();

    expect(mockSpawnCollect).toHaveBeenCalledWith(
      "git",
      [
        "-c",
        "credential.helper=!gh auth git-credential",
        "-c",
        "credential.useHttpPath=true",
        "-C",
        "/tmp/worktree",
        "push",
        "-u",
        "origin",
        "ask/1-123"
      ],
      expect.any(Object)
    );
  });

  it("autoCommitDirtyWorktree returns false for a clean worktree", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(autoCommitDirtyWorktree("/tmp/repo")).resolves.toBe(false);

    expect(mockSpawnCollect).toHaveBeenCalledTimes(1);
  });

  it("autoCommitDirtyWorktree runs add, reset, and commit for a dirty worktree", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: " M src/index.ts\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(Object.assign(new Error("Process exited with code 1"), { stdout: "", stderr: "" }))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(autoCommitDirtyWorktree("/tmp/repo")).resolves.toBe(true);

    expect(mockSpawnCollect).toHaveBeenNthCalledWith(
      2,
      "git",
      ["add", "-A"],
      expect.objectContaining({ cwd: "/tmp/repo" })
    );
    expect(mockSpawnCollect).toHaveBeenNthCalledWith(
      3,
      "git",
      ["reset", "--", "docs/reviews/"],
      expect.objectContaining({ cwd: "/tmp/repo" })
    );
    expect(mockSpawnCollect).toHaveBeenNthCalledWith(
      4,
      "git",
      ["diff", "--cached", "--quiet"],
      expect.objectContaining({ cwd: "/tmp/repo" })
    );
    expect(mockSpawnCollect).toHaveBeenNthCalledWith(
      5,
      "git",
      ["commit", "-m", "review: auto-commit working tree changes"],
      expect.objectContaining({ cwd: "/tmp/repo" })
    );
  });

  it("autoCommitDirtyWorktree skips commit when only review artifacts are dirty", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: " M docs/reviews/ask-1-123/2026-01-01T00-00-00.000Z-review.md\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(autoCommitDirtyWorktree("/tmp/repo")).resolves.toBe(false);

    expect(mockSpawnCollect).toHaveBeenCalledTimes(4);
    expect(mockSpawnCollect).toHaveBeenNthCalledWith(
      2,
      "git",
      ["add", "-A"],
      expect.objectContaining({ cwd: "/tmp/repo" })
    );
    expect(mockSpawnCollect).toHaveBeenNthCalledWith(
      3,
      "git",
      ["reset", "--", "docs/reviews/"],
      expect.objectContaining({ cwd: "/tmp/repo" })
    );
    expect(mockSpawnCollect).toHaveBeenNthCalledWith(
      4,
      "git",
      ["diff", "--cached", "--quiet"],
      expect.objectContaining({ cwd: "/tmp/repo" })
    );
  });

  it("autoCommitDirtyWorktree skips commit when only review artifacts and gitignore artifacts are dirty", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: " M docs/reviews/ask-1-123/2026-01-01T00-00-00.000Z-review.md\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(autoCommitDirtyWorktree("/tmp/repo")).resolves.toBe(false);
  });

  it("autoCommitDirtyWorktree wraps generic git errors as AUTO_COMMIT_FAILED", async () => {
    mockSpawnCollect.mockRejectedValueOnce(new Error("fatal: could not read index"));

    await expect(autoCommitDirtyWorktree("/tmp/repo")).rejects.toMatchObject({
      code: "AUTO_COMMIT_FAILED",
      name: "GitWorkspaceError"
    } satisfies Partial<GitWorkspaceError>);
  });

  it("autoCommitDirtyWorktree propagates GIT_UNAVAILABLE from hasUncommittedChanges", async () => {
    const enoentError = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    mockSpawnCollect.mockRejectedValueOnce(enoentError);

    await expect(autoCommitDirtyWorktree("/tmp/repo")).rejects.toMatchObject({
      code: "GIT_UNAVAILABLE",
      name: "GitWorkspaceError"
    } satisfies Partial<GitWorkspaceError>);
  });

  it("autoCommitAll with excludePaths resets excluded paths before committing", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(Object.assign(new Error("Process exited with code 1"), { stdout: "", stderr: "" }))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await autoCommitAll("/tmp/repo", "test commit", ["docs/reviews/"]);

    expect(result).toBe(true);
    expect(mockSpawnCollect).toHaveBeenNthCalledWith(1, "git", ["add", "-A"], expect.any(Object));
    expect(mockSpawnCollect).toHaveBeenNthCalledWith(2, "git", ["reset", "--", "docs/reviews/"], expect.any(Object));
    expect(mockSpawnCollect).toHaveBeenNthCalledWith(3, "git", ["diff", "--cached", "--quiet"], expect.any(Object));
    expect(mockSpawnCollect).toHaveBeenNthCalledWith(4, "git", ["commit", "-m", "test commit"], expect.any(Object));
  });

  it("autoCommitAll with excludePaths returns false when only excluded files are staged", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await autoCommitAll("/tmp/repo", "test commit", ["docs/reviews/"]);

    expect(result).toBe(false);
    expect(mockSpawnCollect).toHaveBeenCalledTimes(3);
  });

  it("autoCommitAll with no excludePaths commits all changes", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(Object.assign(new Error("Process exited with code 1"), { stdout: "", stderr: "" }))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await autoCommitAll("/tmp/repo", "test commit");

    expect(result).toBe(true);
    expect(mockSpawnCollect).toHaveBeenNthCalledWith(1, "git", ["add", "-A"], expect.any(Object));
    expect(mockSpawnCollect).toHaveBeenNthCalledWith(2, "git", ["diff", "--cached", "--quiet"], expect.any(Object));
    expect(mockSpawnCollect).toHaveBeenNthCalledWith(3, "git", ["commit", "-m", "test commit"], expect.any(Object));
  });

  it("autoCommitAll with empty excludePaths commits all changes", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(Object.assign(new Error("Process exited with code 1"), { stdout: "", stderr: "" }))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await autoCommitAll("/tmp/repo", "test commit", []);

    expect(result).toBe(true);
    expect(mockSpawnCollect).toHaveBeenCalledTimes(3);
  });

  it("autoCommitAll rethrows genuine git errors from diff --cached --quiet", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(Object.assign(
        new Error("Process exited with code 128"),
        { stdout: "", stderr: "fatal: index corrupted" }
      ));

    await expect(autoCommitAll("/tmp/repo", "test commit", ["docs/reviews/"])).rejects.toThrow();
    expect(mockSpawnCollect).toHaveBeenCalledTimes(3);
    expect(mockSpawnCollect).toHaveBeenNthCalledWith(3, "git", ["diff", "--cached", "--quiet"], expect.any(Object));
  });

  it("getCommitsSinceBaseRef returns commit list", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: "abc123 first\n123def second\n", stderr: "" });

    const commits = await getCommitsSinceBaseRef("/tmp/repo", "origin/main");
    expect(commits).toEqual(["abc123 first", "123def second"]);
  });

  it("getCommitsSinceBaseRef returns empty array on failure", async () => {
    mockSpawnCollect.mockRejectedValueOnce(new Error("git failed"));

    const commits = await getCommitsSinceBaseRef("/tmp/repo", "origin/main");
    expect(commits).toEqual([]);
  });

  it("getShortStatus returns porcelain status", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: " M src/index.ts\n?? new.txt\n", stderr: "" });

    const status = await getShortStatus("/tmp/repo");
    expect(status).toBe(" M src/index.ts\n?? new.txt");
  });

  it("getShortStatus returns empty string on failure", async () => {
    mockSpawnCollect.mockRejectedValueOnce(new Error("git failed"));

    const status = await getShortStatus("/tmp/repo");
    expect(status).toBe("");
  });

  it("getUnstagedDiffSummary returns the diff text", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: "diff --git a/src/index.ts b/src/index.ts\n+change", stderr: "" });

    const diff = await getUnstagedDiffSummary("/tmp/repo");
    expect(diff).toBe("diff --git a/src/index.ts b/src/index.ts\n+change");
  });

  it("getUnstagedDiffSummary falls back to --stat when raw diff exceeds 1800 chars", async () => {
    const largeDiff = "a".repeat(1801);
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: largeDiff, stderr: "" })
      .mockResolvedValueOnce({ stdout: " src/index.ts | 2 +-\n", stderr: "" });

    const diff = await getUnstagedDiffSummary("/tmp/repo");
    expect(diff).toBe("src/index.ts | 2 +-");
  });

  it("getUnstagedDiffSummary falls back to --name-only when --stat throws", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "a".repeat(1801), stderr: "" })
      .mockRejectedValueOnce(new Error("stat failed"))
      .mockResolvedValueOnce({ stdout: "src/index.ts\nsrc/new.ts\n", stderr: "" });

    const diff = await getUnstagedDiffSummary("/tmp/repo");
    expect(diff).toBe("src/index.ts\nsrc/new.ts");
  });

  it("getUnstagedDiffSummary falls back to --stat on EMSGSIZE (non-empty overflow stdout)", async () => {
    const overflowError = new Error("Process output exceeded maxBuffer") as Error & { code: string; stdout: string };
    overflowError.code = "EMSGSIZE";
    overflowError.stdout = "diff --git a/src/index.ts b/src/index.ts\n+large".repeat(10000);

    mockSpawnCollect
      .mockRejectedValueOnce(overflowError)
      .mockResolvedValueOnce({ stdout: "src/index.ts | 1 +\n", stderr: "" });

    const diff = await getUnstagedDiffSummary("/tmp/repo");
    expect(diff).toBe("src/index.ts | 1 +");
    expect(diff).not.toContain("truncated");
    expect(diff).not.toContain("diff --git");
  });

  it("getUnstagedDiffSummary falls back to --name-only when --stat throws on EMSGSIZE (non-empty overflow stdout)", async () => {
    const overflowError = new Error("Process output exceeded maxBuffer") as Error & { code: string; stdout: string };
    overflowError.code = "EMSGSIZE";
    overflowError.stdout = "diff --git a/src/index.ts b/src/index.ts\n+large".repeat(10000);

    mockSpawnCollect
      .mockRejectedValueOnce(overflowError)
      .mockRejectedValueOnce(new Error("stat failed"))
      .mockResolvedValueOnce({ stdout: "src/index.ts\n", stderr: "" });

    const diff = await getUnstagedDiffSummary("/tmp/repo");
    expect(diff).toBe("src/index.ts");
    expect(diff).not.toContain("truncated");
  });

  it("getUnstagedDiffSummary returns empty string on total failure", async () => {
    mockSpawnCollect
      .mockRejectedValueOnce(new Error("git failed"))
      .mockRejectedValueOnce(new Error("stat failed"))
      .mockRejectedValueOnce(new Error("name-only failed"));

    const diff = await getUnstagedDiffSummary("/tmp/repo");
    expect(diff).toBe("");
  });

  it("getUnstagedDiffSummary logs warn on EMSGSIZE when logger is provided", async () => {
    const logger = { warn: vi.fn() } as unknown as pino.Logger;
    const overflowError = new Error("overflow") as Error & { code: string; stdout: string };
    overflowError.code = "EMSGSIZE";
    overflowError.stdout = "diff".repeat(10000);
    mockSpawnCollect
      .mockRejectedValueOnce(overflowError)
      .mockResolvedValueOnce({ stdout: "src/index.ts | 1 +\n", stderr: "" });

    await getUnstagedDiffSummary("/tmp/repo", logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: overflowError }),
      "getUnstagedDiffSummary primary diff failed — falling back to --stat/--name-only"
    );
  });

  it("getStagedDiffSummary logs warn on EMSGSIZE when logger is provided", async () => {
    const logger = { warn: vi.fn() } as unknown as pino.Logger;
    const overflowError = new Error("overflow") as Error & { code: string; stdout: string };
    overflowError.code = "EMSGSIZE";
    overflowError.stdout = "diff".repeat(10000);
    mockSpawnCollect
      .mockRejectedValueOnce(overflowError)
      .mockResolvedValueOnce({ stdout: "src/index.ts | 2 +-\n", stderr: "" });

    await getStagedDiffSummary("/tmp/repo", logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: overflowError }),
      "getStagedDiffSummary primary diff failed — falling back to --stat/--name-only"
    );
  });

  it("getStagedDiffSummary returns staged diff", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: "diff --git a/src/index.ts b/src/index.ts\n+staged", stderr: "" });

    const diff = await getStagedDiffSummary("/tmp/repo");
    expect(diff).toBe("diff --git a/src/index.ts b/src/index.ts\n+staged");
  });

  it("getStagedDiffSummary falls back to --stat for large staged diff", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "a".repeat(1801), stderr: "" })
      .mockResolvedValueOnce({ stdout: " src/index.ts | 1 +\n", stderr: "" });

    const diff = await getStagedDiffSummary("/tmp/repo");
    expect(diff).toBe("src/index.ts | 1 +");
  });

  it("getStagedDiffSummary falls back to --name-only when --cached --stat throws", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "a".repeat(1801), stderr: "" })
      .mockRejectedValueOnce(new Error("stat failed"))
      .mockResolvedValueOnce({ stdout: "src/index.ts\n", stderr: "" });

    const diff = await getStagedDiffSummary("/tmp/repo");
    expect(diff).toBe("src/index.ts");
  });

  it("getStagedDiffSummary falls back to --stat on EMSGSIZE for cached diff (non-empty overflow stdout)", async () => {
    const overflowError = new Error("overflow") as Error & { code: string; stdout: string };
    overflowError.code = "EMSGSIZE";
    overflowError.stdout = "diff --git a/src/staged.ts b/src/staged.ts\n+large".repeat(10000);

    mockSpawnCollect
      .mockRejectedValueOnce(overflowError)
      .mockResolvedValueOnce({ stdout: "src/index.ts | 2 +-\n", stderr: "" });

    const diff = await getStagedDiffSummary("/tmp/repo");
    expect(diff).toBe("src/index.ts | 2 +-");
    expect(diff).not.toContain("truncated");
  });

  it("getDefaultBranchBaseRef returns the remote ref", async () => {
    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "refs/remotes/origin/main\n", stderr: "" });

    const ref = await getDefaultBranchBaseRef("/tmp/repo");
    expect(ref).toBe("origin/main");
  });

  it("getDefaultBranchBaseRef returns empty string on failure", async () => {
    mockSpawnCollect
      .mockRejectedValueOnce(new Error("no HEAD"))
      .mockRejectedValueOnce(new Error("no main"))
      .mockRejectedValueOnce(new Error("no master"));

    const ref = await getDefaultBranchBaseRef("/tmp/repo");
    expect(ref).toBe("");
  });

  it("getUnstagedDiffSummary logs warn on non-EMSGSIZE primary failure", async () => {
    const logger = { warn: vi.fn() } as unknown as pino.Logger;
    const primaryError = new Error("fatal: bad revision");
    mockSpawnCollect
      .mockRejectedValueOnce(primaryError)
      .mockResolvedValueOnce({ stdout: "src/index.ts | 1 +\n", stderr: "" });

    const diff = await getUnstagedDiffSummary("/tmp/repo", logger);
    expect(diff).toBe("src/index.ts | 1 +");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: primaryError }),
      "getUnstagedDiffSummary primary diff failed — falling back to --stat/--name-only"
    );
  });

  it("getStagedDiffSummary logs warn on non-EMSGSIZE primary failure", async () => {
    const logger = { warn: vi.fn() } as unknown as pino.Logger;
    const primaryError = new Error("fatal: bad revision");
    mockSpawnCollect
      .mockRejectedValueOnce(primaryError)
      .mockResolvedValueOnce({ stdout: "src/index.ts | 2 +-\n", stderr: "" });

    const diff = await getStagedDiffSummary("/tmp/repo", logger);
    expect(diff).toBe("src/index.ts | 2 +-");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: primaryError }),
      "getStagedDiffSummary primary diff failed — falling back to --stat/--name-only"
    );
  });

  it("getUnstagedDiffSummary falls back to empty string when fallback also fails", async () => {
    mockSpawnCollect
      .mockRejectedValueOnce(new Error("primary failed"))
      .mockRejectedValueOnce(new Error("stat failed"))
      .mockRejectedValueOnce(new Error("name-only failed"));

    const diff = await getUnstagedDiffSummary("/tmp/repo");
    expect(diff).toBe("");
  });
});
