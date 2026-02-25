import { describe, expect, it } from "vitest";
import {
  buildRequestWorktreeBranchName,
  buildRequestWorktreePath
} from "../src/services/requestWorktreeService.js";

describe("requestWorktreeService helpers", () => {
  it("builds deterministic sanitized worktree path", () => {
    const path = buildRequestWorktreePath(
      "/data/repos",
      {
        owner: "My Org",
        repo: "Repo:Name",
        fullName: "My Org/Repo:Name"
      },
      42
    ).replaceAll("\\", "/");

    expect(path.endsWith(".worktrees/my_org/repo_name/42")).toBe(true);
  });

  it("builds ask branch name", () => {
    const branch = buildRequestWorktreeBranchName(13);
    expect(branch.startsWith("ask/13-")).toBe(true);
  });
});

