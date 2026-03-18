import { describe, expect, it } from "vitest";
import { parseIssueDetailJson, parseIssueListJson, parseRepoReference } from "../src/services/githubService.js";

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

describe("parseIssueListJson", () => {
  it("parses issue list entries with normalized fields", () => {
    const parsed = parseIssueListJson(JSON.stringify([
      {
        number: 49,
        title: "Add /issues command",
        url: "https://github.com/DigitumDei/Actuarius/issues/49",
        state: "OPEN",
        body: "Issue body",
        labels: [{ name: "enhancement" }],
        author: { login: "actuarius-bot[bot]" },
        createdAt: "2026-03-12T05:24:53Z",
        updatedAt: "2026-03-12T05:24:53Z"
      }
    ]));

    expect(parsed).toEqual([
      {
        number: 49,
        title: "Add /issues command",
        url: "https://github.com/DigitumDei/Actuarius/issues/49",
        state: "OPEN",
        body: "Issue body",
        labels: ["enhancement"],
        authorLogin: "actuarius-bot[bot]",
        createdAt: "2026-03-12T05:24:53Z",
        updatedAt: "2026-03-12T05:24:53Z"
      }
    ]);
  });

  it("throws when required fields are missing", () => {
    expect(() => parseIssueListJson(JSON.stringify([{ title: "Missing number" }]))).toThrow(
      "GitHub CLI output did not contain required issue list fields."
    );
  });
});

describe("parseIssueDetailJson", () => {
  it("parses issue detail with assignees", () => {
    const parsed = parseIssueDetailJson(JSON.stringify({
      number: 49,
      title: "Add /issues command",
      url: "https://github.com/DigitumDei/Actuarius/issues/49",
      state: "OPEN",
      body: "Detailed issue body",
      labels: [{ name: "enhancement" }, { name: "discord" }],
      author: { login: "actuarius-bot[bot]" },
      assignees: [{ login: "maintainer-1" }],
      createdAt: "2026-03-12T05:24:53Z",
      updatedAt: "2026-03-13T01:02:03Z"
    }));

    expect(parsed).toEqual({
      number: 49,
      title: "Add /issues command",
      url: "https://github.com/DigitumDei/Actuarius/issues/49",
      state: "OPEN",
      body: "Detailed issue body",
      labels: ["enhancement", "discord"],
      authorLogin: "actuarius-bot[bot]",
      assignees: ["maintainer-1"],
      createdAt: "2026-03-12T05:24:53Z",
      updatedAt: "2026-03-13T01:02:03Z"
    });
  });
});
