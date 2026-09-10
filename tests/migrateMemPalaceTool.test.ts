import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/tools/migrateMemPalace.js";

describe("migrateMemPalace tool", () => {
  it("parses explicit palaces, binary, and dry-run", () => {
    const args = parseArgs(["--from-palace", "/old", "--to-palace", "/new", "--cli", "/opt/cli", "--dry-run"]);
    expect(args).toMatchObject({ fromPalace: "/old", toPalace: "/new", cliPath: "/opt/cli", dryRun: true });
  });

  it("rejects identical source and target palaces", () => {
    expect(() => parseArgs(["--from-palace", "/same", "--to-palace", "/same"])).toThrow(/different/);
  });

  it("rejects a flag without a value", () => {
    expect(() => parseArgs(["--from-palace"])).toThrow(/requires a value/);
  });

  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown argument/);
  });
});
