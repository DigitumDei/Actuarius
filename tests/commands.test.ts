import { describe, expect, it } from "vitest";
import { commandBuilders } from "../src/discord/commands.js";

describe("command registration", () => {
  it("registers the branches, cleanup, issues, plan, install, delete, and pr commands", () => {
    const names = commandBuilders.map((builder) => builder.name);
    expect(names).toContain("branches");
    expect(names).toContain("cleanup");
    expect(names).toContain("issues");
    expect(names).toContain("plan");
    expect(names).toContain("install");
    expect(names).toContain("delete");
    expect(names).toContain("pr");
    expect(names).not.toContain("gemini-oauth-file");
  });

  it("registers /model-select with role choices", () => {
    const command = commandBuilders.find((builder) => builder.name === "model-select");
    expect(command).toBeDefined();

    const json = command!.toJSON();
    expect(json.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "role",
          required: false,
          choices: [
            { name: "Default (/ask, /bug, /issue)", value: "default" },
            { name: "Planner (/plan stage A)", value: "planner" },
            { name: "Implementer (/plan stage B)", value: "implementer" }
          ]
        })
      ])
    );
  });

  it("registers /issues with mode and issue options", () => {
    const issuesCommand = commandBuilders.find((builder) => builder.name === "issues");
    expect(issuesCommand).toBeDefined();

    const json = issuesCommand!.toJSON();
    expect(json.options).toEqual([
      expect.objectContaining({
        name: "mode",
        required: false,
        choices: [
          { name: "List", value: "list" },
          { name: "Summary", value: "summary" },
          { name: "Detail", value: "detail" }
        ]
      }),
      expect.objectContaining({
        name: "issue",
        required: false,
        min_value: 1
      })
    ]);
  });

  it("registers /install with allowlisted and apt package options", () => {
    const installCommand = commandBuilders.find((builder) => builder.name === "install");
    expect(installCommand).toBeDefined();

    const json = installCommand!.toJSON();
    expect(json.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "package",
          required: false,
          choices: expect.arrayContaining([
            expect.objectContaining({ name: "rustup-default-stable", value: "rustup-default-stable" }),
            expect.objectContaining({ name: "npm-prettier", value: "npm-prettier" }),
            expect.objectContaining({ name: "java-temurin", value: "java-temurin" }),
            expect.objectContaining({ name: "gradle", value: "gradle" }),
            expect.objectContaining({ name: "kotlin-compiler", value: "kotlin-compiler" }),
            expect.objectContaining({ name: "android-sdk", value: "android-sdk" })
          ])
        }),
        expect.objectContaining({
          name: "apt-package",
          required: false
        }),
        expect.objectContaining({
          name: "scope",
          required: true,
          choices: expect.arrayContaining([
            expect.objectContaining({ name: "Repo", value: "repo" }),
            expect.objectContaining({ name: "Request", value: "request" })
          ])
        })
      ])
    );
  });
});
