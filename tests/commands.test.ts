import { describe, expect, it } from "vitest";
import { commandBuilders } from "../src/discord/commands.js";

describe("command registration", () => {
  it("registers the branches, cleanup, and delete commands", () => {
    const names = commandBuilders.map((builder) => builder.name);
    expect(names).toContain("branches");
    expect(names).toContain("cleanup");
    expect(names).toContain("delete");
  });
});
