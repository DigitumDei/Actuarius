import { describe, expect, it } from "vitest";
import { buildRepoChannelName, buildThreadName } from "../src/discord/naming.js";

describe("buildRepoChannelName", () => {
  it("normalizes owner and repo into channel-safe name", () => {
    const name = buildRepoChannelName("My-Org", "Hello.World", new Set());
    expect(name).toBe("repo-my-org-hello-world");
  });

  it("adds hash suffix when the base name exists", () => {
    const existing = new Set(["repo-org-repo"]);
    const name = buildRepoChannelName("org", "repo", existing);
    expect(name.startsWith("repo-org-repo-")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(100);
  });
});

describe("buildThreadName", () => {
  it("creates thread name with ask prefix", () => {
    const name = buildThreadName("Create release branch for next sprint");
    expect(name.startsWith("ask-")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(100);
  });
});

