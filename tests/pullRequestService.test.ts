import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, access } from "node:fs/promises";

vi.mock("../src/utils/spawnCollect.js");
vi.mock("../src/services/githubAuthService.js", () => ({
  getGitHubCommandEnvironment: vi.fn(() => process.env)
}));

const { spawnCollect } = await import("../src/utils/spawnCollect.js");
const mockSpawnCollect = vi.mocked(spawnCollect);
const { createDraftPullRequest, updateDraftPullRequest } = await import("../src/services/pullRequestService.js");

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
        "--body-file",
        expect.stringMatching(/body\.md$/u)
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


it("preserves multiline large bodies in a temporary file and removes it after publication",async()=>{
  mockSpawnCollect.mockReset();
  const body="Review "+"x".repeat(70000)+"\nSecond paragraph with `code`, $variable and "+String.fromCodePoint(0x1f680);
  let bodyFile="";
  mockSpawnCollect.mockImplementationOnce(async(_file,args)=>{
    bodyFile=String(args[args.indexOf("--body-file")+1]);
    expect(await readFile(bodyFile,"utf8")).toBe(body);
    return {stdout:"https://github.com/owner/repo/pull/12",stderr:""};
  });
  await createDraftPullRequest({worktreePath:"/tmp/worktree",head:"work",base:"main",title:"Checkpoint",body});
  await expect(access(bodyFile)).rejects.toThrow();
});
it("passes cancellation to publication subprocesses and preserves the original abort without retrying PR lookup",async()=>{
  mockSpawnCollect.mockReset();const controller=new AbortController();
  const stopped=Object.assign(new Error("Lease lost"),{code:"ABORT_ERR",stopKind:"lease_loss",stdout:"partial push"});
  mockSpawnCollect.mockImplementationOnce(async(_file,_args,options)=>{
    expect(options.signal).toBe(controller.signal);controller.abort(stopped);throw stopped;
  });
  await expect(createDraftPullRequest({worktreePath:"/tmp/worktree",head:"work",base:"main",title:"Checkpoint",body:"report",signal:controller.signal})).rejects.toBe(stopped);
  expect(mockSpawnCollect).toHaveBeenCalledOnce();
  await expect(updateDraftPullRequest("/tmp/worktree","https://github.com/owner/repo/pull/12","report",controller.signal)).rejects.toBe(stopped);
  expect(mockSpawnCollect).toHaveBeenCalledOnce();
});
