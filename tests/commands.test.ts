import { describe, expect, it } from "vitest";
import { commandBuilders } from "../src/discord/commands.js";

describe("command registration", () => {
  it("registers the branches, cleanup, issues, plan, install, uninstall, delete, and pr commands", () => {
    const names = commandBuilders.map((builder) => builder.name);
    expect(names).toContain("branches");
    expect(names).toContain("cleanup");
    expect(names).toContain("issues");
    expect(names).toContain("plan");
    expect(names).toContain("install");
    expect(names).toContain("uninstall");
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
            { name: "Implementer (/plan stage B)", value: "implementer" },
            { name: "Reviewer Slot 1", value: "reviewer-1" },
            { name: "Reviewer Slot 2", value: "reviewer-2" },
            { name: "Reviewer Slot 3", value: "reviewer-3" },
            { name: "Reviewer Slot 4", value: "reviewer-4" },
            { name: "Reviewer Analyzer", value: "reviewer-analyzer" },
            { name: "Reviewer Judge", value: "reviewer-judge" },
            { name: "Reviewer Summarizer", value: "reviewer-summarizer" }
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

  it("registers /ask with prompt and attachment options", () => {
    const askCommand = commandBuilders.find((builder) => builder.name === "ask");
    expect(askCommand).toBeDefined();

    const json = askCommand!.toJSON();
    expect(json.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "prompt",
          required: true,
          type: 3
        }),
        expect.objectContaining({
          name: "attachment1",
          required: false,
          type: 11
        }),
        expect.objectContaining({
          name: "attachment2",
          required: false,
          type: 11
        }),
        expect.objectContaining({
          name: "attachment3",
          required: false,
          type: 11
        }),
        expect.objectContaining({
          name: "attachment4",
          required: false,
          type: 11
        }),
        expect.objectContaining({
          name: "attachment5",
          required: false,
          type: 11
        })
      ])
    );
  });

  it("registers /revise with optional string findings option", () => {
    const reviseCommand = commandBuilders.find((builder) => builder.name === "revise");
    expect(reviseCommand).toBeDefined();

    const json = reviseCommand!.toJSON();
    expect(json.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "findings",
          required: false,
          type: 3
        })
      ])
    );
  });

  it("registers /plan with optional boolean iterative option", () => {
    const planCommand = commandBuilders.find((builder) => builder.name === "plan");
    expect(planCommand).toBeDefined();

    const json = planCommand!.toJSON();
    expect(json.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "iterative",
          required: false,
          type: 5
        })
      ])
    );
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

  it("registers /uninstall with package and scope options", () => {
    const uninstallCommand = commandBuilders.find((builder) => builder.name === "uninstall");
    expect(uninstallCommand).toBeDefined();
    expect(uninstallCommand!.toJSON().options).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "package", required: false }),
      expect.objectContaining({ name: "apt-package", required: false }),
      expect.objectContaining({ name: "scope", required: true })
    ]));
  });
});
