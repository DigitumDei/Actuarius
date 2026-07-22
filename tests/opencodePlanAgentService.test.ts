import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpencodePlanAgentSnapshot,
  ensureOpencodePlanAgentFiles,
  OPENCODE_IMPLEMENT_OC_AGENT,
  OPENCODE_PLAN_OC_AGENT,
  setOpencodePlanAgentModel
} from "../src/services/opencodePlanAgentService.js";

const PLANNER_TEMPLATE = `---
description: Test planning agent.
mode: primary
temperature: 0.1
---

Planner instructions that must be preserved.
`;

const IMPLEMENTER_TEMPLATE = `---
description: Test implementation agent.
mode: subagent
hidden: true
---

Implementer instructions that must be preserved.
`;

describe("opencodePlanAgentService", () => {
  let tempRoot: string;
  let templateDir: string;
  let configDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "actuarius-opencode-agent-test-"));
    templateDir = join(tempRoot, "templates");
    configDir = join(tempRoot, "managed");
    await mkdir(join(templateDir, "agents"), { recursive: true });
    await writeFile(
      join(templateDir, "opencode.json"),
      JSON.stringify({ share: "disabled", subagent_depth: 1 }, null, 2),
      "utf8"
    );
    await writeFile(join(templateDir, "agents", `${OPENCODE_PLAN_OC_AGENT}.md`), PLANNER_TEMPLATE, "utf8");
    await writeFile(
      join(templateDir, "agents", `${OPENCODE_IMPLEMENT_OC_AGENT}.md`),
      IMPLEMENTER_TEMPLATE,
      "utf8"
    );
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("creates the managed config and both agent files from templates", async () => {
    const state = await ensureOpencodePlanAgentFiles({ configDir, templateDir });

    expect(state).toEqual({
      configDir,
      models: { planner: null, implementer: null }
    });
    expect(await readFile(join(configDir, "opencode.json"), "utf8")).toBe(
      JSON.stringify({ share: "disabled", subagent_depth: 1 }, null, 2)
    );
    expect(await readFile(join(configDir, "agents", `${OPENCODE_PLAN_OC_AGENT}.md`), "utf8"))
      .toBe(PLANNER_TEMPLATE);
    expect(await readFile(join(configDir, "agents", `${OPENCODE_IMPLEMENT_OC_AGENT}.md`), "utf8"))
      .toBe(IMPLEMENTER_TEMPLATE);
  });

  it("does not overwrite existing operator edits when ensuring managed files", async () => {
    await ensureOpencodePlanAgentFiles({ configDir, templateDir });
    const editedPlanner = PLANNER_TEMPLATE.replace(
      "Planner instructions that must be preserved.",
      "Operator-edited planner instructions."
    );
    const editedConfig = "{\n  \"share\": \"manual\"\n}";
    await writeFile(join(configDir, "agents", `${OPENCODE_PLAN_OC_AGENT}.md`), editedPlanner, "utf8");
    await writeFile(join(configDir, "opencode.json"), editedConfig, "utf8");

    await ensureOpencodePlanAgentFiles({ configDir, templateDir });

    expect(await readFile(join(configDir, "agents", `${OPENCODE_PLAN_OC_AGENT}.md`), "utf8"))
      .toBe(editedPlanner);
    expect(await readFile(join(configDir, "opencode.json"), "utf8")).toBe(editedConfig);
  });

  it("rejects a planner file that no longer declares a primary agent", async () => {
    await ensureOpencodePlanAgentFiles({ configDir, templateDir });
    const plannerPath = join(configDir, "agents", `${OPENCODE_PLAN_OC_AGENT}.md`);
    await writeFile(plannerPath, PLANNER_TEMPLATE.replace("mode: primary", "mode: subagent"), "utf8");

    await expect(ensureOpencodePlanAgentFiles({ configDir, templateDir })).rejects.toMatchObject({
      name: "OpencodePlanAgentConfigError",
      code: "INVALID_AGENT_FILE",
      message: expect.stringContaining("mode: primary")
    });
  });

  it("sets independent models, preserves agent instructions, and clears a model", async () => {
    let state = await setOpencodePlanAgentModel(
      "planner",
      "openai/gpt-5.6-sol",
      { configDir, templateDir }
    );
    expect(state.models).toEqual({ planner: "openai/gpt-5.6-sol", implementer: null });

    state = await setOpencodePlanAgentModel(
      "implementer",
      "anthropic/claude-sonnet-4-5",
      { configDir, templateDir }
    );
    expect(state.models).toEqual({
      planner: "openai/gpt-5.6-sol",
      implementer: "anthropic/claude-sonnet-4-5"
    });

    const plannerPath = join(configDir, "agents", `${OPENCODE_PLAN_OC_AGENT}.md`);
    const implementerPath = join(configDir, "agents", `${OPENCODE_IMPLEMENT_OC_AGENT}.md`);
    expect(await readFile(plannerPath, "utf8")).toContain("Planner instructions that must be preserved.");
    expect(await readFile(implementerPath, "utf8")).toContain("Implementer instructions that must be preserved.");

    state = await setOpencodePlanAgentModel("planner", null, { configDir, templateDir });
    expect(state.models).toEqual({ planner: null, implementer: "anthropic/claude-sonnet-4-5" });
    expect(await readFile(plannerPath, "utf8")).not.toMatch(/^model:/mu);
    expect(await readFile(plannerPath, "utf8")).toContain("Planner instructions that must be preserved.");
  });

  it.each([
    "gpt-5.6-sol",
    "openai/gpt 5",
    "/gpt-5",
    "openai/"
  ])("rejects invalid model identifier %j", async (model) => {
    await expect(setOpencodePlanAgentModel("planner", model, { configDir, templateDir }))
      .rejects.toMatchObject({
        name: "OpencodePlanAgentConfigError",
        code: "INVALID_MODEL"
      });
  });

  it("keeps a request snapshot immutable and removes it on cleanup", async () => {
    await setOpencodePlanAgentModel("planner", "openai/gpt-5.6-sol", { configDir, templateDir });
    await setOpencodePlanAgentModel("implementer", "openai/gpt-5.6-terra", { configDir, templateDir });

    const snapshot = await createOpencodePlanAgentSnapshot({ configDir, templateDir, tempRoot });
    expect(snapshot.models).toEqual({
      planner: "openai/gpt-5.6-sol",
      implementer: "openai/gpt-5.6-terra"
    });

    await setOpencodePlanAgentModel("planner", "openai/gpt-5.7", { configDir, templateDir });
    await setOpencodePlanAgentModel("implementer", null, { configDir, templateDir });

    const snapshotPlanner = await readFile(
      join(snapshot.configDir, "agents", `${OPENCODE_PLAN_OC_AGENT}.md`),
      "utf8"
    );
    const snapshotImplementer = await readFile(
      join(snapshot.configDir, "agents", `${OPENCODE_IMPLEMENT_OC_AGENT}.md`),
      "utf8"
    );
    expect(snapshotPlanner).toMatch(/^model: openai\/gpt-5\.6-sol$/mu);
    expect(snapshotPlanner).not.toContain("openai/gpt-5.7");
    expect(snapshotImplementer).toMatch(/^model: openai\/gpt-5\.6-terra$/mu);

    await snapshot.cleanup();
    await expect(access(snapshot.configDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
