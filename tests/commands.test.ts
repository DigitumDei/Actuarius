import { describe, expect, it } from "vitest";
import { commandBuilders } from "../src/discord/commands.js";

describe("command registration", () => {
  it("registers the branches, cleanup, issues, and delete commands", () => {
    const names = commandBuilders.map((builder) => builder.name);
    expect(names).toContain("branches");
    expect(names).toContain("cleanup");
    expect(names).toContain("issues");
    expect(names).toContain("delete");
    expect(names).not.toContain("gemini-oauth-file");
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
});
