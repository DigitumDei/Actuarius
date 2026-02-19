import { describe, expect, it } from "vitest";
import { parseRepoReference } from "../src/services/githubService.js";

describe("parseRepoReference", () => {
  it("parses owner/name format", () => {
    const parsed = parseRepoReference("octocat/Hello-World");
    expect(parsed).toEqual({
      owner: "octocat",
      repo: "Hello-World",
      fullName: "octocat/Hello-World"
    });
  });

  it("parses github url format", () => {
    const parsed = parseRepoReference("https://github.com/octocat/Hello-World.git");
    expect(parsed).toEqual({
      owner: "octocat",
      repo: "Hello-World",
      fullName: "octocat/Hello-World"
    });
  });

  it("returns null for invalid host", () => {
    expect(parseRepoReference("https://gitlab.com/org/repo")).toBeNull();
  });

  it("returns null for invalid token", () => {
    expect(parseRepoReference("not-a-repo")).toBeNull();
  });
});

