import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IterativeTaskLoopInput } from "../src/services/iterativeTaskLoopService.js";

const mockRunProviderText = vi.fn();
const mockGetHeadSha = vi.fn();
const mockGetDiffSinceRef = vi.fn();
const mockHasUncommittedChanges = vi.fn();
const mockAutoCommitAll = vi.fn();
const mockSend = vi.fn().mockResolvedValue(undefined);

const defaultInput: IterativeTaskLoopInput = {
  tasks: [
    { title: "Task 1", description: "First task" },
    { title: "Task 2", description: "Second task" }
  ],
  overview: "Test overview",
  originalPrompt: "Do the thing",
  repoFullName: "octocat/hello-world",
  worktreePath: "/tmp/worktree",
  threadChannel: { send: mockSend },
  plannerProvider: "claude",
  plannerModel: undefined,
  implementerProvider: "claude",
  implementerModel: undefined,
  runProviderText: mockRunProviderText,
  timeoutMs: 1000,
  env: undefined,
  getHeadSha: mockGetHeadSha,
  getDiffSinceRef: mockGetDiffSinceRef,
  hasUncommittedChanges: mockHasUncommittedChanges,
  autoCommitAll: mockAutoCommitAll
};

const { runIterativeTaskLoop } = await import("../src/services/iterativeTaskLoopService.js");

describe("runIterativeTaskLoop", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetHeadSha.mockResolvedValue("abc123");
    mockGetDiffSinceRef.mockResolvedValue("diff --git a/src/index.ts b/src/index.ts\n+change");
    mockHasUncommittedChanges.mockResolvedValue(false);
    mockAutoCommitAll.mockResolvedValue(undefined);
  });

  it("runs each task through implementer then verifier", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("implementer output 1")
      .mockResolvedValueOnce("APPROVED")
      .mockResolvedValueOnce("implementer output 2")
      .mockResolvedValueOnce("APPROVED");

    const result = await runIterativeTaskLoop(defaultInput);

    expect(result.taskResults).toHaveLength(2);
    expect(result.taskResults[0]!.approved).toBe(true);
    expect(result.taskResults[1]!.approved).toBe(true);
    expect(mockRunProviderText).toHaveBeenCalledTimes(4);
  });

  it("handles an empty task list without provider calls", async () => {
    const result = await runIterativeTaskLoop({
      ...defaultInput,
      tasks: []
    });

    expect(result.taskResults).toEqual([]);
    expect(mockGetHeadSha).not.toHaveBeenCalled();
    expect(mockRunProviderText).not.toHaveBeenCalled();
  });

  it("verification approval stops retries", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("implementer output")
      .mockResolvedValueOnce("APPROVED");

    const result = await runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }]
    });

    expect(result.taskResults).toHaveLength(1);
    expect(result.taskResults[0]!.approved).toBe(true);
    expect(result.taskResults[0]!.tweakAttempts).toBe(0);
    expect(mockRunProviderText).toHaveBeenCalledTimes(2);
  });

  it("verification rejection triggers tweak attempts up to max", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("implementer output 1")
      .mockResolvedValueOnce("NEEDS FIX: missing error handling")
      .mockResolvedValueOnce("implementer output 2")
      .mockResolvedValueOnce("NEEDS FIX: still missing error handling")
      .mockResolvedValueOnce("implementer output 3")
      .mockResolvedValueOnce("APPROVED");

    const result = await runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }]
    });

    expect(result.taskResults).toHaveLength(1);
    expect(result.taskResults[0]!.approved).toBe(true);
    expect(result.taskResults[0]!.tweakAttempts).toBe(2);
    expect(mockRunProviderText).toHaveBeenCalledTimes(6);
  });

  it("accepts APPROVED when the first verification line has punctuation or markdown", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("implementer output")
      .mockResolvedValueOnce("**APPROVED.**\nLooks good.");

    const result = await runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }]
    });

    expect(result.taskResults[0]!.approved).toBe(true);
    expect(result.taskResults[0]!.tweakAttempts).toBe(0);
  });

  it("accepts APPROVED after leading blank lines without splitting large verifier output", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("implementer output")
      .mockResolvedValueOnce(`\n\n  APPROVED:\n${"details\n".repeat(1000)}`);

    const result = await runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }]
    });

    expect(result.taskResults[0]!.approved).toBe(true);
    expect(result.taskResults[0]!.tweakAttempts).toBe(0);
  });

  it("does not treat negated approval output as approved", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("implementer output 1")
      .mockResolvedValueOnce("NOT APPROVED - missing error handling")
      .mockResolvedValueOnce("implementer output 2")
      .mockResolvedValueOnce("APPROVED");

    const result = await runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }]
    });

    expect(result.taskResults[0]!.approved).toBe(true);
    expect(result.taskResults[0]!.tweakAttempts).toBe(1);
    expect(mockRunProviderText).toHaveBeenCalledTimes(4);
  });

  it("does not treat qualified approval output as approved", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("implementer output 1")
      .mockResolvedValueOnce("APPROVED in part, but tests are missing")
      .mockResolvedValueOnce("implementer output 2")
      .mockResolvedValueOnce("APPROVED");

    const result = await runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }]
    });

    expect(result.taskResults[0]!.approved).toBe(true);
    expect(result.taskResults[0]!.tweakAttempts).toBe(1);
  });

  it("max tweaks proceeds instead of failing", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("implementer output 1")
      .mockResolvedValueOnce("STILL WRONG")
      .mockResolvedValueOnce("implementer output 2")
      .mockResolvedValueOnce("STILL WRONG")
      .mockResolvedValueOnce("implementer output 3")
      .mockResolvedValueOnce("STILL WRONG");

    const result = await runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }]
    });

    expect(result.taskResults).toHaveLength(1);
    expect(result.taskResults[0]!.approved).toBe(false);
    expect(result.taskResults[0]!.tweakAttempts).toBe(3);
    expect(mockRunProviderText).toHaveBeenCalledTimes(6);
    expect(mockSend).toHaveBeenCalledWith(
      expect.stringContaining("max tweaks reached")
    );
  });

  it("includes prior planner feedback in retry implementer prompt", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("implementer output 1")
      .mockResolvedValueOnce("NEEDS FIX: add validation")
      .mockResolvedValueOnce("implementer output 2")
      .mockResolvedValueOnce("APPROVED");

    await runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }]
    });

    const implementerPrompt2 = mockRunProviderText.mock.calls[2]![0].prompt;
    expect(implementerPrompt2).toContain("Prior planner feedback for this task");
    expect(implementerPrompt2).toContain("NEEDS FIX: add validation");
  });

  it("captures pre-task sha and computes diff per task", async () => {
    mockGetHeadSha
      .mockResolvedValueOnce("sha-before-task1")
      .mockResolvedValueOnce("sha-before-task2");
    mockGetDiffSinceRef
      .mockResolvedValueOnce("diff for task 1")
      .mockResolvedValueOnce("diff for task 2");
    mockRunProviderText
      .mockResolvedValueOnce("impl 1")
      .mockResolvedValueOnce("APPROVED")
      .mockResolvedValueOnce("impl 2")
      .mockResolvedValueOnce("APPROVED");

    const result = await runIterativeTaskLoop(defaultInput);

    expect(mockGetHeadSha).toHaveBeenNthCalledWith(1, "/tmp/worktree");
    expect(mockGetHeadSha).toHaveBeenNthCalledWith(2, "/tmp/worktree");
    expect(mockGetDiffSinceRef).toHaveBeenNthCalledWith(1, "/tmp/worktree", "sha-before-task1");
    expect(mockGetDiffSinceRef).toHaveBeenNthCalledWith(2, "/tmp/worktree", "sha-before-task2");
    expect(result.taskResults[0]!.diff).toBe("diff for task 1");
    expect(result.taskResults[1]!.diff).toBe("diff for task 2");
  });

  it("keeps the same task-start sha across tweak attempts", async () => {
    mockGetHeadSha.mockResolvedValueOnce("sha-before-task");
    mockGetDiffSinceRef
      .mockResolvedValueOnce("diff after attempt 1")
      .mockResolvedValueOnce("diff after attempt 2");
    mockRunProviderText
      .mockResolvedValueOnce("impl 1")
      .mockResolvedValueOnce("NEEDS FIX")
      .mockResolvedValueOnce("impl 2")
      .mockResolvedValueOnce("APPROVED");

    const result = await runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }]
    });

    expect(mockGetHeadSha).toHaveBeenCalledTimes(1);
    expect(mockGetDiffSinceRef).toHaveBeenNthCalledWith(1, "/tmp/worktree", "sha-before-task");
    expect(mockGetDiffSinceRef).toHaveBeenNthCalledWith(2, "/tmp/worktree", "sha-before-task");
    expect(result.taskResults[0]!.diff).toBe("diff after attempt 2");
  });

  it("requires implementer to commit all changes for each task", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("impl 1")
      .mockResolvedValueOnce("APPROVED");

    await runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }]
    });

    const implementerPrompt = mockRunProviderText.mock.calls[0]![0].prompt;
    expect(implementerPrompt).toContain("Commit all changes for this task before responding");
    expect(implementerPrompt).toContain("The worktree must be clean when you respond");
  });

  it("auto-commits and notifies thread when implementer leaves uncommitted changes", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("impl 1")
      .mockResolvedValueOnce("APPROVED");
    mockHasUncommittedChanges.mockResolvedValueOnce(true);

    const result = await runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }]
    });

    expect(mockAutoCommitAll).toHaveBeenCalledWith("/tmp/worktree", "task 1/1: Task 1 (auto-committed)");
    expect(mockSend).toHaveBeenCalledWith(expect.stringContaining("auto-committed"));
    expect(result.taskResults).toHaveLength(1);
    expect(result.taskResults[0]!.approved).toBe(true);
  });

  it("auto-commits per-task and continues when task 2 also leaves uncommitted changes", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("impl 1")
      .mockResolvedValueOnce("APPROVED")
      .mockResolvedValueOnce("impl 2")
      .mockResolvedValueOnce("APPROVED");
    mockHasUncommittedChanges
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mockGetDiffSinceRef
      .mockResolvedValueOnce("task 1 diff")
      .mockResolvedValueOnce("task 2 diff");

    const result = await runIterativeTaskLoop(defaultInput);

    expect(mockAutoCommitAll).toHaveBeenCalledTimes(1);
    expect(mockAutoCommitAll).toHaveBeenCalledWith("/tmp/worktree", "task 2/2: Task 2 (auto-committed)");
    expect(result.taskResults).toHaveLength(2);
    expect(result.taskResults[0]!.approved).toBe(true);
    expect(result.taskResults[1]!.approved).toBe(true);
  });

  it("preserves blank-line separators in implementer prompts", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("impl 1")
      .mockResolvedValueOnce("APPROVED");

    await runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }]
    });

    const implementerPrompt = mockRunProviderText.mock.calls[0]![0].prompt;
    expect(implementerPrompt).toContain("Repository: octocat/hello-world\n\nOriginal request:");
    expect(implementerPrompt).toContain("Do the thing\n\nPlan overview:");
    expect(implementerPrompt).toContain("Test overview\n\nCurrent task to implement:");
  });

  it("includes completed task summaries in subsequent implementer prompts", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("impl 1")
      .mockResolvedValueOnce("APPROVED")
      .mockResolvedValueOnce("impl 2")
      .mockResolvedValueOnce("APPROVED");

    await runIterativeTaskLoop(defaultInput);

    const implementerPrompt2 = mockRunProviderText.mock.calls[2]![0].prompt;
    expect(implementerPrompt2).toContain("Completed tasks");
    expect(implementerPrompt2).toContain("Task 1 - approved");
  });

  it("includes original request, overview, and completed tasks in verifier prompts", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("impl 1")
      .mockResolvedValueOnce("APPROVED")
      .mockResolvedValueOnce("impl 2")
      .mockResolvedValueOnce("APPROVED");

    await runIterativeTaskLoop(defaultInput);

    const verifierPrompt2 = mockRunProviderText.mock.calls[3]![0].prompt;
    expect(verifierPrompt2).toContain("Original request:");
    expect(verifierPrompt2).toContain("Do the thing");
    expect(verifierPrompt2).toContain("Plan overview:");
    expect(verifierPrompt2).toContain("Test overview");
    expect(verifierPrompt2).toContain("Completed tasks");
    expect(verifierPrompt2).toContain("Task 1 - approved");
  });

  it("forwards planner and implementer models plus env to provider calls", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("impl 1")
      .mockResolvedValueOnce("APPROVED");
    const env = { ...process.env, TEST_ENV_FLAG: "1" };

    await runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }],
      plannerModel: "planner-model",
      implementerModel: "implementer-model",
      env
    });

    expect(mockRunProviderText).toHaveBeenNthCalledWith(1, expect.objectContaining({
      provider: "claude",
      model: "implementer-model",
      env
    }));
    expect(mockRunProviderText).toHaveBeenNthCalledWith(2, expect.objectContaining({
      provider: "claude",
      model: "planner-model",
      env
    }));
  });

  it("omits env from provider calls when env is undefined", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("impl 1")
      .mockResolvedValueOnce("APPROVED");

    await runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }],
      env: undefined
    });

    expect(mockRunProviderText.mock.calls[0]![0]).not.toHaveProperty("env");
    expect(mockRunProviderText.mock.calls[1]![0]).not.toHaveProperty("env");
  });

  it("propagates loop errors", async () => {
    mockGetDiffSinceRef.mockRejectedValueOnce(new Error("diff failed"));
    mockRunProviderText.mockResolvedValueOnce("impl 1");

    await expect(runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }]
    })).rejects.toThrow("diff failed");
  });

  it("propagates getHeadSha errors before starting a task", async () => {
    mockGetHeadSha.mockRejectedValueOnce(new Error("head failed"));

    await expect(runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }]
    })).rejects.toThrow("head failed");

    expect(mockRunProviderText).not.toHaveBeenCalled();
  });

  it("propagates provider errors inside the loop", async () => {
    mockRunProviderText.mockRejectedValueOnce(new Error("provider failed"));

    await expect(runIterativeTaskLoop({
      ...defaultInput,
      tasks: [{ title: "Task 1", description: "First task" }]
    })).rejects.toThrow("provider failed");
  });

  it("sends task progress messages to the thread channel", async () => {
    mockRunProviderText
      .mockResolvedValueOnce("impl 1")
      .mockResolvedValueOnce("APPROVED")
      .mockResolvedValueOnce("impl 2")
      .mockResolvedValueOnce("APPROVED");

    await runIterativeTaskLoop(defaultInput);

    expect(mockSend).toHaveBeenCalledWith(expect.stringContaining("Task 1/2: Task 1 - implementing..."));
    expect(mockSend).toHaveBeenCalledWith(expect.stringContaining("Task 1/2: Task 1 - planner verifying..."));
    expect(mockSend).toHaveBeenCalledWith(expect.stringContaining("Task 2/2: Task 2 - implementing..."));
    expect(mockSend).toHaveBeenCalledWith(expect.stringContaining("Task 2/2: Task 2 - planner verifying..."));
  });
});
