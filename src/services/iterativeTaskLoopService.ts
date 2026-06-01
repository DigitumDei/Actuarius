import type { AiProvider } from "../db/types.js";

export interface IterativePlanTask {
  title: string;
  description: string;
}

export interface IterativeTaskOutput {
  title: string;
  description: string;
  implementerOutput: string;
  verificationOutput: string;
  approved: boolean;
  tweakAttempts: number;
  diff: string;
}

export interface IterativeTaskLoopInput {
  tasks: IterativePlanTask[];
  overview: string;
  originalPrompt: string;
  repoFullName: string;
  worktreePath: string;
  threadChannel: { send: (content: string) => Promise<unknown> };
  plannerProvider: AiProvider;
  plannerModel: string | undefined;
  implementerProvider: AiProvider;
  implementerModel: string | undefined;
  runProviderText: (input: {
    provider: AiProvider;
    prompt: string;
    cwd: string;
    timeoutMs: number;
    model?: string;
    env?: NodeJS.ProcessEnv;
  }) => Promise<string>;
  timeoutMs: number;
  env: NodeJS.ProcessEnv | undefined;
  getHeadSha: (repoPath: string, ref?: string) => Promise<string>;
  getDiffSinceRef: (repoPath: string, baseRef: string) => Promise<string>;
}

const MAX_TWEAKS_PER_TASK = 3;
const TASK_TITLE_MESSAGE_LIMIT = 160;

function formatTaskTitleForMessage(title: string): string {
  const singleLine = title.replace(/\s+/g, " ").trim();
  if (singleLine.length <= TASK_TITLE_MESSAGE_LIMIT) {
    return singleLine;
  }
  return `${singleLine.slice(0, TASK_TITLE_MESSAGE_LIMIT - 3).trimEnd()}...`;
}

function isApprovedVerification(output: string): boolean {
  const firstLine = output.trim().split("\n")[0]?.trim() ?? "";
  return /\bAPPROVED\b/iu.test(firstLine);
}

export async function runIterativeTaskLoop(input: IterativeTaskLoopInput): Promise<{
  taskResults: IterativeTaskOutput[];
}> {
  const { tasks, overview, originalPrompt, repoFullName, worktreePath, threadChannel } = input;
  const taskResults: IterativeTaskOutput[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const taskIndex = i + 1;
    const taskCount = tasks.length;
    let tweakAttempts = 0;
    let lastVerificationOutput = "";
    let implementerOutput = "";
    let diff = "";
    let approved = false;
    const preTaskSha = await input.getHeadSha(worktreePath);
    const taskTitle = formatTaskTitleForMessage(task.title);

    while (tweakAttempts < MAX_TWEAKS_PER_TASK && !approved) {
      const attemptLabel = tweakAttempts > 0 ? ` (tweak ${tweakAttempts}/${MAX_TWEAKS_PER_TASK})` : "";
      await threadChannel.send(`Task ${taskIndex}/${taskCount}: ${taskTitle} - implementing${attemptLabel}...`);

      const completedSummaries = taskResults
        .map((r, idx) => `  ${idx + 1}. ${r.title} - ${r.approved ? "approved" : "completed with issues"}`)
        .join("\n");

      const priorFeedback = tweakAttempts > 0
        ? `\nPrior planner feedback for this task:\n${lastVerificationOutput}`
        : "";

      const implementerPrompt = [
        `Repository: ${repoFullName}`,
        "",
        "Original request:",
        originalPrompt,
        "",
        "Plan overview:",
        overview,
        "",
        completedSummaries ? `Completed tasks:\n${completedSummaries}\n` : "",
        "Current task to implement:",
        `Title: ${task.title}`,
        `Description: ${task.description}`,
        "",
        "Implement this task. Make code changes in this worktree.",
        "Do not create or commit a plan file. Keep changes scoped to the request.",
        "Commit all changes for this task before responding. If this is a tweak attempt, amend or add commits so HEAD includes the complete task result.",
        priorFeedback
      ].filter(Boolean).join("\n");

      implementerOutput = await input.runProviderText({
        provider: input.implementerProvider,
        prompt: implementerPrompt,
        cwd: worktreePath,
        timeoutMs: input.timeoutMs,
        ...(input.implementerModel ? { model: input.implementerModel } : {}),
        ...(input.env ? { env: input.env } : {})
      });

      diff = await input.getDiffSinceRef(worktreePath, preTaskSha);

      await threadChannel.send(`Task ${taskIndex}/${taskCount}: ${taskTitle} - planner verifying...`);

      const verificationCompletedSummaries = taskResults
        .map((r, idx) => `  ${idx + 1}. ${r.title} - ${r.approved ? "approved" : "completed with issues"}`)
        .join("\n");

      const verificationPrompt = [
        `Repository: ${repoFullName}`,
        "",
        "Original request:",
        originalPrompt,
        "",
        "Plan overview:",
        overview,
        "",
        verificationCompletedSummaries ? `Completed tasks:\n${verificationCompletedSummaries}\n` : "",
        `Task: ${task.title}`,
        `Description: ${task.description}`,
        "",
        "The implementer was asked to implement this task. Below is the implementer's output and the code changes made.",
        "",
        "Implementer output:",
        implementerOutput,
        "",
        "Code changes (git diff):",
        diff,
        "",
        "Has the task been implemented correctly?",
        "Reply with APPROVED on the first line if satisfied, or provide specific feedback on what needs to be changed."
      ].join("\n");

      const verificationOutput = await input.runProviderText({
        provider: input.plannerProvider,
        prompt: verificationPrompt,
        cwd: worktreePath,
        timeoutMs: input.timeoutMs,
        ...(input.plannerModel ? { model: input.plannerModel } : {}),
        ...(input.env ? { env: input.env } : {})
      });

      lastVerificationOutput = verificationOutput;
      approved = isApprovedVerification(verificationOutput);

      if (!approved) {
        tweakAttempts++;
        if (tweakAttempts >= MAX_TWEAKS_PER_TASK) {
          await threadChannel.send(
            `Task ${taskIndex}/${taskCount}: ${taskTitle} - max tweaks reached (${MAX_TWEAKS_PER_TASK}). Proceeding to next task.`
          );
        }
      } else {
        await threadChannel.send(`Task ${taskIndex}/${taskCount}: ${taskTitle} - approved.`);
      }
    }

    taskResults.push({
      title: task.title,
      description: task.description,
      implementerOutput,
      verificationOutput: lastVerificationOutput,
      approved,
      tweakAttempts,
      diff
    });
  }

  return { taskResults };
}
