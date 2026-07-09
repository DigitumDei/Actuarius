export interface ThreadPromptEntry {
  role: "user" | "assistant";
  text: string;
}

export interface PromptTask {
  title: string;
  description: string;
}

export interface IssueSummaryPromptIssue {
  number: number;
  title: string;
  labels: string[];
  authorLogin: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  body: string;
}

export interface ReviewPromptOutput {
  reviewer: string;
  provider: string;
  model?: string;
  text: string;
}

export interface ReviewPromptCritiqueOutput extends ReviewPromptOutput {
  round: number;
}

export interface ReviewPromptJudgeRound {
  round: number;
  text: string;
  consensusReached: boolean;
}

export const OPENCODE_TEMPFILE_DIRECTIVE =
  "Read the attached file and follow its full contents as your prompt.";

function clipPromptText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 16).trimEnd()}\n...(truncated)`;
}

function matchesNewUserMessage(entryText: string, newMessageContent: string): boolean {
  const normalized = newMessageContent.trim();
  return entryText === normalized || entryText.startsWith(`${normalized}\n\n**Attachments**\n`);
}

export function buildRepositoryScopedPrompt(input: {
  repoFullName: string;
  prompt: string;
}): string {
  return `Repository: ${input.repoFullName}\n\n${input.prompt}`;
}

export function buildThreadFollowUpPrompt(input: {
  history: ThreadPromptEntry[];
  newMessageContent: string;
}): string {
  if (input.history.length === 0) {
    return input.newMessageContent;
  }

  const lines = [
    "This is an ongoing code assistance session. The conversation history is below.",
    "Respond to the final [User] message.",
    ""
  ];
  for (const entry of input.history) {
    lines.push(`[${entry.role === "user" ? "User" : "Assistant"}]: ${entry.text}`);
    lines.push("");
  }

  const lastEntry = input.history[input.history.length - 1];
  const normalizedNewMessage = input.newMessageContent.trim();
  if (lastEntry?.role !== "user" || !matchesNewUserMessage(lastEntry.text, normalizedNewMessage)) {
    lines.push(`[User]: ${normalizedNewMessage}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

export function buildIssueCreationPrompt(input: {
  requestPrompt: string;
  defaultLabel: string;
}): string {
  return `Analyze the codebase against the master branch to produce a structured GitHub issue report for the following request.
Request: ${input.requestPrompt}

Create the issue directly using the GitHub CLI (\`gh issue create\`).
Make sure to include a clear title, a markdown formatted description (with reproduction steps if it's a bug), and the label "${input.defaultLabel}".
If it is a bug, also ensure the "bug" label is applied.
If the label does not exist on the repository, omit the --label flag rather than failing.
Output the result of the command or the link to the created issue.`;
}

export function buildIssueSummaryPrompt(input: {
  repoFullName: string;
  issues: IssueSummaryPromptIssue[];
}): string {
  const issuePayload = input.issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    labels: issue.labels,
    author: issue.authorLogin,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    body: issue.body
  }));

  return `Summarize the open GitHub issues for ${input.repoFullName}.\n`
    + "Return plain text only.\n"
    + "Format each issue as a single bullet in the form `- #<number> <title>: <short summary>`.\n"
    + "Keep each summary to one sentence and keep the total response concise.\n\n"
    + JSON.stringify(issuePayload, null, 2);
}

export function buildPlanPrompt(input: {
  repoFullName: string;
  requestPrompt: string;
  iterative: boolean;
  maxTasks: number;
}): string {
  if (input.iterative) {
    return [
      `Repository: ${input.repoFullName}`,
      "",
      "Produce a structured iterative implementation plan for this request.",
      "Do not edit files. Do not run the implementation. Inspect the codebase as needed and return only the plan JSON.",
      "Return ONLY valid JSON with no markdown formatting, no code fences, no prose outside the JSON.",
      "",
      "The JSON must have this exact shape:",
      "{",
      '  "overview": "brief overview of the plan",',
      '  "tasks": [',
      '    { "title": "Short task title", "description": "Detailed description of what to implement" }',
      "  ]",
      "}",
      "",
      "Guidelines:",
      "- Each task should be independently implementable and verifiable",
      "- Tasks should build on each other in a logical order",
      `- Maximum ${input.maxTasks} tasks`,
      "- Do not include testing tasks unless specifically requested",
      "",
      "Request:",
      input.requestPrompt
    ].join("\n");
  }

  return [
    `Repository: ${input.repoFullName}`,
    "",
    "Produce a structured implementation plan for this request.",
    "Do not edit files. Do not run the implementation. Inspect the codebase as needed and return only the plan.",
    "",
    "Request:",
    input.requestPrompt
  ].join("\n");
}

export function buildPlanImplementationPrompt(input: {
  repoFullName: string;
  originalPrompt: string;
  planText: string;
}): string {
  return [
    `Repository: ${input.repoFullName}`,
    "",
    "Implement the request using the approved plan below. Make code changes in this worktree.",
    "Do not create or commit a plan file. Keep changes scoped to the request.",
    "",
    "Original request:",
    input.originalPrompt,
    "",
    "Plan:",
    input.planText
  ].join("\n");
}

export function buildRevisionPlanPrompt(input: {
  repoFullName: string;
  originalPrompt: string;
  currentDiff: string;
  maxTasks: number;
  findings?: string | null;
  reviewSummary?: string | null;
}): string {
  const lines: string[] = [
    `Repository: ${input.repoFullName}`,
    "",
    "Produce a structured iterative implementation plan to fix remaining issues in this request.",
    "Do not edit files. Do not run the implementation. Inspect the codebase as needed and return only the plan JSON.",
    "Return ONLY valid JSON with no markdown formatting, no code fences, no prose outside the JSON.",
    "",
    "The JSON must have this exact shape:",
    "{",
    '  "overview": "brief overview of what needs to be fixed/completed",',
    '  "tasks": [',
    '    { "title": "Short task name", "description": "Full task description" }',
    "  ]",
    "}",
    "",
    "Guidelines:",
    "- Each task should be independently implementable and verifiable",
    "- Tasks should build on each other in a logical order",
    `- Maximum ${input.maxTasks} tasks`,
    "- Scope tasks only to remaining fixes and corrections based on the findings below",
    "",
    "Original request:",
    input.originalPrompt,
    "",
    "Current branch diff (changes since default branch):",
    input.currentDiff || "(no diff)"
  ];

  if (input.findings) {
    lines.push("", "Findings to address:", input.findings);
  } else if (input.reviewSummary) {
    lines.push("", "Latest review summary:", input.reviewSummary);
  }

  return lines.join("\n");
}

export function buildIterativeTaskImplementationPrompt(input: {
  repoFullName: string;
  originalPrompt: string;
  overview: string;
  task: PromptTask;
  completedSummaries?: string;
  priorFeedback?: string;
}): string {
  const priorFeedback = input.priorFeedback
    ? ["", "Prior planner feedback for this task:", input.priorFeedback]
    : [];

  return [
    `Repository: ${input.repoFullName}`,
    "",
    "Original request:",
    input.originalPrompt,
    "",
    "Plan overview:",
    input.overview,
    "",
    ...(input.completedSummaries ? [`Completed tasks:\n${input.completedSummaries}`, ""] : []),
    "Current task to implement:",
    `Title: ${input.task.title}`,
    `Description: ${input.task.description}`,
    "",
    "Implement this task. Make code changes in this worktree.",
    "Do not create or commit a plan file. Keep changes scoped to the request.",
    "Commit all changes for this task before responding. If this is a tweak attempt, add a new commit for the tweak or amend only the current task's latest commit.",
    "Do not rewrite commits from prior tasks. The worktree must be clean when you respond.",
    ...priorFeedback
  ].join("\n");
}

export function buildIterativeTaskVerificationPrompt(input: {
  repoFullName: string;
  originalPrompt: string;
  overview: string;
  task: PromptTask;
  completedSummaries?: string;
  implementerOutput: string;
  diff: string;
}): string {
  return [
    `Repository: ${input.repoFullName}`,
    "",
    "Original request:",
    input.originalPrompt,
    "",
    "Plan overview:",
    input.overview,
    "",
    ...(input.completedSummaries ? [`Completed tasks:\n${input.completedSummaries}`, ""] : []),
    `Task: ${input.task.title}`,
    `Description: ${input.task.description}`,
    "",
    "The implementer was asked to implement this task. Below is the implementer's output and the code changes made.",
    "",
    "Implementer output:",
    input.implementerOutput,
    "",
    "Code changes (git diff):",
    input.diff,
    "",
    "Has the task been implemented correctly?",
    "Reply with APPROVED on the first line if satisfied, or provide specific feedback on what needs to be changed."
  ].join("\n");
}

export function buildAnalyzerPrompt(input: {
  repoFullName: string;
  branchName: string;
  threadHistory: string;
}): string {
  return [
    `You are the analyzer for an adversarial code review of ${input.repoFullName}.`,
    `Review branch: ${input.branchName}`,
    "Your job is to read the conversation history below and determine what this change is trying to accomplish.",
    "Do not look at code. Do not suggest where reviewers should focus. Just describe the intent.",
    "Return plain text with these headings: Intent, Success Criteria.",
    "- Intent: what problem is being solved and what the change is trying to achieve",
    "- Success Criteria: what a correct implementation should accomplish from the requester's perspective",
    "",
    "Conversation history:",
    "```text",
    clipPromptText(input.threadHistory, 20_000),
    "```"
  ].join("\n");
}

export function buildReviewerPrompt(input: {
  repoFullName: string;
  branchName: string;
  baseBranch: string;
  analyzerText: string;
  changedFiles: string[];
  diffText: string;
  reviewerLabel: string;
  round: number;
  previousReview?: string;
  critiqueFeedback?: string[];
  judgeSummary?: string;
}): string {
  const lines = [
    `You are ${input.reviewerLabel}, an adversarial reviewer for ${input.repoFullName}.`,
    `Review branch: ${input.branchName}`,
    `Diff base: ${input.baseBranch}`,
    `Review round: ${input.round}`,
    "Be skeptical. Do not assume the implementation is correct. Look for bugs, regressions, missing tests, and weak reasoning.",
    "Do not soften criticism to agree with prior analysis. If a concern is weak, say so plainly. If the change looks solid, say that too.",
    "Return plain text with these headings: Blocking Issues, Non-Blocking Issues, Missing Tests, Strong Concerns, Confidence.",
    "",
    "Change intent (what this change is trying to achieve — evaluate the code against this):",
    "```text",
    clipPromptText(input.analyzerText, 20_000),
    "```",
    "",
    "Changed files:",
    ...(input.changedFiles.length > 0 ? input.changedFiles.map((file) => `- ${file}`) : ["- (none)"]),
    "",
    "Diff:",
    "```diff",
    clipPromptText(input.diffText, 120_000),
    "```"
  ];

  if (input.previousReview) {
    lines.push("", "Your previous round review:", "```text", clipPromptText(input.previousReview, 20_000), "```");
  }

  if ((input.critiqueFeedback?.length ?? 0) > 0) {
    lines.push("", "Critiques of your previous review:");
    for (const feedback of input.critiqueFeedback ?? []) {
      lines.push("```text", clipPromptText(feedback, 10_000), "```");
    }
  }

  if (input.judgeSummary) {
    lines.push("", "Judge guidance from the previous round:", "```text", clipPromptText(input.judgeSummary, 10_000), "```");
  }

  return lines.join("\n");
}

export function buildCritiquePrompt(input: {
  repoFullName: string;
  branchName: string;
  baseBranch: string;
  reviewerLabel: string;
  round: number;
  ownReview: string;
  peerReviews: ReviewPromptOutput[];
}): string {
  return [
    `You are ${input.reviewerLabel}, critically reviewing peer code reviews for ${input.repoFullName}.`,
    `Review branch: ${input.branchName}`,
    `Diff base: ${input.baseBranch}`,
    `Critique round: ${input.round}`,
    "Assess whether each peer review comment is valid, overstated, unsupported, or missing evidence.",
    "Do not defend your own review by default; be rigorous and specific.",
    "Return plain text with these headings: Valid Comments, Invalid Or Weak Comments, Missing Context, Feedback To Peers.",
    "",
    "Your review for this round:",
    "```text",
    clipPromptText(input.ownReview, 20_000),
    "```",
    "",
    "Peer reviews:"
  ].concat(
    input.peerReviews.flatMap((review) => [
      "",
      `Reviewer: ${review.reviewer} (${review.provider}${review.model ? ` / ${review.model}` : ""})`,
      "```text",
      clipPromptText(review.text, 20_000),
      "```"
    ])
  ).join("\n");
}

export function buildJudgePrompt(input: {
  repoFullName: string;
  branchName: string;
  baseBranch: string;
  round: number;
  reviewerOutputs: ReviewPromptOutput[];
  critiqueOutputs: ReviewPromptCritiqueOutput[];
}): string {
  return [
    `You are the judge for an adversarial code review of ${input.repoFullName}.`,
    `Review branch: ${input.branchName}`,
    `Diff base: ${input.baseBranch}`,
    `Consensus round: ${input.round}`,
    "Decide whether the reviewers have reached practical consensus on the important issues.",
    "Return JSON only with this exact shape:",
    "{",
    '  "consensusReached": true | false,',
    '  "consensusSummary": "string",',
    '  "reviewerGuidance": [{"reviewer":"string","feedback":"string"}]',
    "}",
    "Set `consensusReached` to true only when the remaining disagreements are minor or clearly resolved.",
    "",
    "Reviewer outputs:"
  ].concat(
    input.reviewerOutputs.flatMap((reviewer) => [
      "",
      `Reviewer: ${reviewer.reviewer} (${reviewer.provider}${reviewer.model ? ` / ${reviewer.model}` : ""})`,
      "```text",
      clipPromptText(reviewer.text, 20_000),
      "```"
    ]),
    ["", "Critique outputs:"],
    input.critiqueOutputs.flatMap((critique) => [
      "",
      `Reviewer: ${critique.reviewer} (${critique.provider}${critique.model ? ` / ${critique.model}` : ""})`,
      "```text",
      clipPromptText(critique.text, 20_000),
      "```"
    ])
  ).join("\n");
}

export function buildSummarizerPrompt(input: {
  repoFullName: string;
  branchName: string;
  baseBranch: string;
  analyzerText: string;
  reviewerOutputs: ReviewPromptOutput[];
  critiqueOutputs: ReviewPromptCritiqueOutput[];
  judgeRounds: ReviewPromptJudgeRound[];
}): string {
  return [
    `You are the neutral summarizer for an adversarial code review of ${input.repoFullName}.`,
    `Review branch: ${input.branchName}`,
    `Diff base: ${input.baseBranch}`,
    "Synthesize the analyzer and reviewer outputs into a final verdict.",
    "Return JSON only with this exact shape:",
    "{",
    '  "executiveSummary": "2-4 sentences describing what the branch does, summarising the key consensus findings, and explaining why the verdict was reached. Must be substantive analysis — do NOT write meta-commentary such as \'I have reviewed the outputs\' or \'I now have sufficient context\'.",',
    '  "blockingIssues": [{"title":"string","rationale":"string","file":"optional path"}],',
    '  "nonBlockingIssues": [{"title":"string","rationale":"string","file":"optional path"}],',
    '  "missingTests": ["string"],',
    '  "disputedIssues": ["string"],',
    '  "outstandingConcerns": ["string"],',
    '  "verdict": "ready_for_pr" | "revise"',
    "}",
    "Use `ready_for_pr` only if there are no unresolved blocking issues.",
    "Include only consensus issues in `blockingIssues` and `nonBlockingIssues`.",
    "Put unresolved but strongly-held reviewer concerns in `outstandingConcerns`.",
    "",
    "Analyzer output:",
    "```text",
    clipPromptText(input.analyzerText, 20_000),
    "```",
    "",
    "Reviewer outputs:"
  ].concat(
    input.reviewerOutputs.flatMap((reviewer) => [
      "",
      `Reviewer: ${reviewer.reviewer} (${reviewer.provider}${reviewer.model ? ` / ${reviewer.model}` : ""})`,
      "```text",
      clipPromptText(reviewer.text, 20_000),
      "```"
    ]),
    ["", "Critique outputs:"],
    input.critiqueOutputs.flatMap((critique) => [
      "",
      `Round ${critique.round} critique: ${critique.reviewer} (${critique.provider}${critique.model ? ` / ${critique.model}` : ""})`,
      "```text",
      clipPromptText(critique.text, 20_000),
      "```"
    ]),
    ["", "Judge outputs:"],
    input.judgeRounds.flatMap((judgeRound) => [
      "",
      `Round ${judgeRound.round} consensus: ${judgeRound.consensusReached ? "reached" : "not reached"}`,
      "```text",
      clipPromptText(judgeRound.text, 20_000),
      "```"
    ])
  ).join("\n");
}
