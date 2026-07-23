import { describe, expect, it } from "vitest";
import { buildRepositoryMemoryScopedPrompt } from "../src/services/llmPromptBuilders.js";

describe("buildRepositoryMemoryScopedPrompt", () => {
  it("injects the exact dynamically resolved repository wing", () => {
    const prompt = buildRepositoryMemoryScopedPrompt({
      prompt: "Implement the requested change.",
      memoryWing: "wing_shotquill"
    });

    expect(prompt).toContain("Implement the requested change.");
    expect(prompt).toContain("project memory wing for the repository being worked on is `wing_shotquill`");
    expect(prompt).toContain("Do not derive or invent a wing from the repository owner/name.");
    expect(prompt).toContain("durable repository knowledge with `mempalace_add_drawer`");
    expect(prompt).toContain("Project diary entries are local-only");
  });

  it("uses a different resolved wing without embedding an Actuarius-specific default", () => {
    const prompt = buildRepositoryMemoryScopedPrompt({
      prompt: "Review this repository.",
      memoryWing: "wing_wellnesswingman"
    });

    expect(prompt).toContain("`wing_wellnesswingman`");
    expect(prompt).not.toContain("`wing_actuarius`");
  });

  it("leaves prompts unchanged when repository memory is unavailable", () => {
    expect(buildRepositoryMemoryScopedPrompt({
      prompt: "Answer the question.",
      memoryWing: null
    })).toBe("Answer the question.");
  });
});
