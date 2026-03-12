import { describe, expect, it } from "vitest";
import { commandBuilders } from "../src/discord/commands.js";

describe("command registration", () => {
  it("registers the branches and delete commands", () => {
    const names = commandBuilders.map((builder) => builder.name);
    expect(names).toContain("branches");
    expect(names).toContain("delete");
  });
});
