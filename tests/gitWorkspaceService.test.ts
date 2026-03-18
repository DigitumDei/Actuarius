import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/spawnCollect.js");

const { spawnCollect } = await import("../src/utils/spawnCollect.js");
const mockSpawnCollect = vi.mocked(spawnCollect);

const {
  buildRepoCheckoutPath,
  cleanupDeletedRemoteBranches,
  GitWorkspaceError,
  listBranches
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
});
