import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/spawnCollect.js");
vi.mock("../src/services/githubAuthService.js", () => ({
  configureRepositoryGitAuth: vi.fn().mockResolvedValue(undefined),
  ensureGitHubCliAuthenticated: vi.fn().mockResolvedValue(undefined),
  getGitHubCommandEnvironment: vi.fn(() => process.env)
}));

const { spawnCollect } = await import("../src/utils/spawnCollect.js");
const mockSpawnCollect = vi.mocked(spawnCollect);

const {
  buildRepoCheckoutPath,
  cleanupDeletedRemoteBranches,
  detectDefaultBranch,
  GitWorkspaceError,
  getDiffSinceRef,
  getHeadSha,
  getReviewDiff,
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
});
