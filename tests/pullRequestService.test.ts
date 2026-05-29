import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/spawnCollect.js");
vi.mock("../src/services/githubAuthService.js", () => ({
  getGitHubCommandEnvironment: vi.fn(() => process.env)
}));

const { spawnCollect } = await import("../src/utils/spawnCollect.js");
const mockSpawnCollect = vi.mocked(spawnCollect);
const { createDraftPullRequest } = await import("../src/services/pullRequestService.js");

describe("pullRequestService", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates a draft pull request with the expected gh arguments", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: "https://github.com/owner/repo/pull/12\n", stderr: "" });

    await expect(
      createDraftPullRequest({
        worktreePath: "/tmp/worktree",
        head: "ask/1-123",
        base: "main",
        title: "Add feature",
        body: "Request body"
      })
    ).resolves.toBe("https://github.com/owner/repo/pull/12");

    expect(mockSpawnCollect).toHaveBeenCalledWith(
      "gh",
      [
        "pr",
        "create",
        "--draft",
        "--head",
        "ask/1-123",
        "--base",
        "main",
        "--title",
        "Add feature",
        "--body",
        "Request body"
      ],
      expect.objectContaining({
        cwd: "/tmp/worktree",
        timeoutMs: 60_000
      })
    );
  });

  it("returns the existing PR URL when gh reports a PR already exists", async () => {
    mockSpawnCollect
      .mockRejectedValueOnce(Object.assign(new Error("Process exited with code 1"), {
        stderr: "a pull request for branch \"ask/1-123\" already exists"
      }))
      .mockResolvedValueOnce({ stdout: "https://github.com/owner/repo/pull/12\n", stderr: "" });

    await expect(
      createDraftPullRequest({
        worktreePath: "/tmp/worktree",
        head: "ask/1-123",
        base: "main",
        title: "Add feature",
        body: "Request body"
      })
    ).resolves.toBe("https://github.com/owner/repo/pull/12");

    expect(mockSpawnCollect).toHaveBeenNthCalledWith(
      2,
      "gh",
      ["pr", "view", "ask/1-123", "--json", "url", "-q", ".url"],
      expect.any(Object)
    );
  });
});
