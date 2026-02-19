import { describe, expect, it } from "vitest";
import { buildRepoCheckoutPath } from "../src/services/gitWorkspaceService.js";

describe("buildRepoCheckoutPath", () => {
  it("builds a deterministic lowercase path", () => {
    const path = buildRepoCheckoutPath("/data/repos", "DigitumDei", "Actuarius").replaceAll("\\", "/");
    expect(path.endsWith("digitumdei/actuarius")).toBe(true);
  });

  it("sanitizes invalid path characters", () => {
    const path = buildRepoCheckoutPath("/data/repos", "My Org", "repo:name").replaceAll("\\", "/");
    expect(path.endsWith("my_org/repo_name")).toBe(true);
  });
});
