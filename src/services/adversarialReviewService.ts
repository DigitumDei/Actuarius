import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import type { AppDatabase } from "../db/database.js";
import type { AiProvider, ReviewVerdict } from "../db/types.js";
import { getReviewDiff } from "./gitWorkspaceService.js";

export interface ReviewModelIdentity {
  provider: AiProvider;
  model?: string;
}

export interface ReviewModelRunner extends ReviewModelIdentity {
  label: string;
  run(input: { prompt: string; cwd: string; timeoutMs: number; model?: string }): Promise<string>;
}

interface AnalyzerStageResult {
  text: string;
}

interface ReviewerStageResult {
  round: number;
  reviewer: string;
  provider: AiProvider;
  model?: string;
  text: string;
}

interface ReviewCritiqueResult {
  round: number;
  reviewer: string;
  provider: AiProvider;
  model?: string;
  text: string;
}

interface JudgeStageResult {
  round: number;
  text: string;
  consensusReached: boolean;
  consensusSummary: string;
  reviewerGuidance: Array<{
    reviewer: string;
    feedback: string;
  }>;
}

export interface ReviewIssue {
  title: string;
  severity: "blocking" | "non_blocking";
  rationale: string;
  file?: string;
}

export interface ReviewSummary {
  executiveSummary: string;
  blockingIssues: ReviewIssue[];
  nonBlockingIssues: ReviewIssue[];
  missingTests: string[];
  disputedIssues: string[];
  outstandingConcerns: string[];
  verdict: ReviewVerdict;
}

export interface AdversarialReviewResult {
  reviewRunId: number;
  baseBranch: string;
  diffBaseRef: string;
  diffHeadSha: string;
  changedFiles: string[];
  reviewersSucceeded: number;
  reviewersAttempted: number;
  summary: ReviewSummary;
  summaryMarkdown: string;
  artifactPath: string;
  rawResult: {
    analyzer: AnalyzerStageResult;
    reviewers: ReviewerStageResult[];
    critiques: ReviewCritiqueResult[];
    judgeRounds: JudgeStageResult[];
    summarizerRawText: string;
  };
}

export class AdversarialReviewError extends Error {
  public readonly code:
    | "INSUFFICIENT_REVIEWERS"
    | "EMPTY_DIFF"
    | "PIPELINE_FAILED";

  public constructor(code: "INSUFFICIENT_REVIEWERS" | "EMPTY_DIFF" | "PIPELINE_FAILED", message: string) {
    super(message);
    this.name = "AdversarialReviewError";
    this.code = code;
  }
}

function clip(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 16).trimEnd()}\n...(truncated)`;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fencedMatch = /^```(?:json|markdown|md|text)?\s*([\s\S]*?)```$/u.exec(trimmed);
  return fencedMatch?.[1]?.trim() ?? trimmed;
}

function summarizeMalformedSummary(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return "Summarizer returned empty output.";
  }

  const firstSentence = normalized.match(/^(.{1,600}?[.!?])(?:\s|$)/u)?.[1]?.trim();
  if (firstSentence) {
    return firstSentence;
  }

  const firstWords = normalized.split(/\s+/u).slice(0, 40).join(" ");
  return clip(firstWords, 600);
}

export function parseStructuredSummary(rawText: string): ReviewSummary {
  const cleaned = stripCodeFence(rawText);

  try {
    const parsed = JSON.parse(cleaned) as Partial<ReviewSummary> & {
      blockingIssues?: Array<Partial<ReviewIssue>>;
      nonBlockingIssues?: Array<Partial<ReviewIssue>>;
    };
    const blockingIssues = (parsed.blockingIssues ?? [])
      .filter((issue) => typeof issue?.title === "string" && typeof issue?.rationale === "string")
      .map((issue) => ({
        title: issue.title!,
        rationale: issue.rationale!,
        severity: "blocking" as const,
        ...(typeof issue.file === "string" ? { file: issue.file } : {})
      }));
    const nonBlockingIssues = (parsed.nonBlockingIssues ?? [])
      .filter((issue) => typeof issue?.title === "string" && typeof issue?.rationale === "string")
      .map((issue) => ({
        title: issue.title!,
        rationale: issue.rationale!,
        severity: "non_blocking" as const,
        ...(typeof issue.file === "string" ? { file: issue.file } : {})
      }));
    const missingTests = Array.isArray(parsed.missingTests)
      ? [...new Set(parsed.missingTests.filter((item): item is string => typeof item === "string" && item.trim().length > 0))]
      : [];
    const disputedIssues = Array.isArray(parsed.disputedIssues)
      ? [...new Set(parsed.disputedIssues.filter((item): item is string => typeof item === "string" && item.trim().length > 0))]
      : [];
    const outstandingConcerns = Array.isArray((parsed as { outstandingConcerns?: unknown }).outstandingConcerns)
      ? [...new Set((parsed as { outstandingConcerns: unknown[] }).outstandingConcerns.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      ))]
      : [];
    const verdict = parsed.verdict === "ready_for_pr" ? "ready_for_pr" : "revise";
    const executiveSummary = typeof parsed.executiveSummary === "string" && parsed.executiveSummary.trim().length > 0
      ? parsed.executiveSummary.trim()
      : "Summarizer returned unstructured output. Manual review recommended.";

    return {
      executiveSummary,
      blockingIssues,
      nonBlockingIssues,
      missingTests,
      disputedIssues,
      outstandingConcerns,
      verdict
    };
  } catch {
    const verdict: ReviewVerdict = /\bready_for_pr\b/i.test(cleaned) ? "ready_for_pr" : "revise";
    return {
      executiveSummary: summarizeMalformedSummary(cleaned),
      blockingIssues: [],
      nonBlockingIssues: [],
      missingTests: [],
      disputedIssues: [],
      outstandingConcerns: [],
      verdict
    };
  }
}

function parseJudgeDecision(rawText: string): Omit<JudgeStageResult, "round" | "text"> {
  const cleaned = stripCodeFence(rawText);

  try {
    const parsed = JSON.parse(cleaned) as Partial<{
      consensusReached: boolean;
      consensusSummary: string;
      reviewerGuidance: Array<Partial<{ reviewer: string; feedback: string }>>;
    }>;

    const reviewerGuidance = Array.isArray(parsed.reviewerGuidance)
      ? parsed.reviewerGuidance
        .filter((item) => typeof item?.reviewer === "string" && typeof item?.feedback === "string")
        .map((item) => ({
          reviewer: item.reviewer!.trim(),
          feedback: item.feedback!.trim()
        }))
      : [];

    return {
      consensusReached: parsed.consensusReached === true,
      consensusSummary:
        typeof parsed.consensusSummary === "string" && parsed.consensusSummary.trim().length > 0
          ? parsed.consensusSummary.trim()
          : "Judge returned unstructured output.",
      reviewerGuidance
    };
  } catch {
    return {
      consensusReached: /\bconsensus(?:\s+has)?\s+been\s+reached\b/i.test(cleaned) || /\bconsensusReached\"\s*:\s*true/i.test(cleaned),
      consensusSummary: summarizeMalformedSummary(cleaned),
      reviewerGuidance: []
    };
  }
}

function renderIssueList(issues: ReviewIssue[]): string[] {
  if (issues.length === 0) {
    return ["- None"];
  }

  return issues.map((issue) => {
    const filePart = issue.file ? ` (${issue.file})` : "";
    return `- ${issue.title}${filePart}: ${issue.rationale}`;
  });
}

export function renderReviewMarkdown(input: {
  requestId: number;
  branchName: string;
  baseBranch: string;
  diffHeadSha: string;
  changedFiles: string[];
  analyzerText: string;
  reviewers: ReviewerStageResult[];
  critiques: ReviewCritiqueResult[];
  judgeRounds: JudgeStageResult[];
  summary: ReviewSummary;
}): string {
  const lines = [
    "# Adversarial Review",
    "",
    `- Request ID: ${input.requestId}`,
    `- Branch: ${input.branchName}`,
    `- Diff Base: ${input.baseBranch}`,
    `- Reviewed Commit: ${input.diffHeadSha}`,
    `- Verdict: ${input.summary.verdict}`,
    "",
    "## Executive Summary",
    "",
    input.summary.executiveSummary,
    "",
    "## Changed Files",
    "",
    ...(input.changedFiles.length > 0 ? input.changedFiles.map((file) => `- ${file}`) : ["- None"]),
    "",
    "## Blocking Issues",
    "",
    ...renderIssueList(input.summary.blockingIssues),
    "",
    "## Non-Blocking Issues",
    "",
    ...renderIssueList(input.summary.nonBlockingIssues),
    "",
    "## Missing Tests",
    "",
    ...(input.summary.missingTests.length > 0 ? input.summary.missingTests.map((item) => `- ${item}`) : ["- None"]),
    "",
    "## Disputed Issues",
    "",
    ...(input.summary.disputedIssues.length > 0 ? input.summary.disputedIssues.map((item) => `- ${item}`) : ["- None"]),
    "",
    "## Outstanding Concerns",
    "",
    ...(input.summary.outstandingConcerns.length > 0
      ? input.summary.outstandingConcerns.map((item) => `- ${item}`)
      : ["- None"]),
    "",
    "## Analyzer Output",
    "",
    "```text",
    input.analyzerText.trim() || "(no analyzer output)",
    "```",
    "",
    "## Reviewer Outputs",
    ""
  ];

  for (const reviewer of input.reviewers) {
    lines.push(`### ${reviewer.reviewer} (${reviewer.provider}${reviewer.model ? ` / ${reviewer.model}` : ""})`);
    lines.push("");
    lines.push("```text");
    lines.push(reviewer.text.trim() || "(no reviewer output)");
    lines.push("```");
    lines.push("");
  }

  lines.push("## Critique Outputs");
  lines.push("");

  for (const critique of input.critiques) {
    lines.push(`### Round ${critique.round}: ${critique.reviewer} (${critique.provider}${critique.model ? ` / ${critique.model}` : ""})`);
    lines.push("");
    lines.push("```text");
    lines.push(critique.text.trim() || "(no critique output)");
    lines.push("```");
    lines.push("");
  }

  lines.push("## Judge Outputs");
  lines.push("");

  for (const judgeRound of input.judgeRounds) {
    lines.push(`### Round ${judgeRound.round}`);
    lines.push("");
    lines.push(`- Consensus reached: ${judgeRound.consensusReached ? "yes" : "no"}`);
    lines.push(`- Summary: ${judgeRound.consensusSummary}`);
    if (judgeRound.reviewerGuidance.length > 0) {
      lines.push("- Reviewer guidance:");
      for (const guidance of judgeRound.reviewerGuidance) {
        lines.push(`- ${guidance.reviewer}: ${guidance.feedback}`);
      }
    }
    lines.push("");
    lines.push("```text");
    lines.push(judgeRound.text.trim() || "(no judge output)");
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

function buildAnalyzerPrompt(input: {
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
    clip(input.threadHistory, 20_000),
    "```"
  ].join("\n");
}

function buildReviewerPrompt(input: {
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
    clip(input.analyzerText, 20_000),
    "```",
    "",
    "Changed files:",
    ...(input.changedFiles.length > 0 ? input.changedFiles.map((file) => `- ${file}`) : ["- (none)"]),
    "",
    "Diff:",
    "```diff",
    clip(input.diffText, 120_000),
    "```"
  ];

  if (input.previousReview) {
    lines.push("", "Your previous round review:", "```text", clip(input.previousReview, 20_000), "```");
  }

  if ((input.critiqueFeedback?.length ?? 0) > 0) {
    lines.push("", "Critiques of your previous review:");
    for (const feedback of input.critiqueFeedback ?? []) {
      lines.push("```text", clip(feedback, 10_000), "```");
    }
  }

  if (input.judgeSummary) {
    lines.push("", "Judge guidance from the previous round:", "```text", clip(input.judgeSummary, 10_000), "```");
  }

  return lines.join("\n");
}

function buildCritiquePrompt(input: {
  repoFullName: string;
  branchName: string;
  baseBranch: string;
  reviewerLabel: string;
  round: number;
  ownReview: string;
  peerReviews: ReviewerStageResult[];
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
    clip(input.ownReview, 20_000),
    "```",
    "",
    "Peer reviews:"
  ].concat(
    input.peerReviews.flatMap((review) => [
      "",
      `Reviewer: ${review.reviewer} (${review.provider}${review.model ? ` / ${review.model}` : ""})`,
      "```text",
      clip(review.text, 20_000),
      "```"
    ])
  ).join("\n");
}

function buildJudgePrompt(input: {
  repoFullName: string;
  branchName: string;
  baseBranch: string;
  round: number;
  reviewerOutputs: ReviewerStageResult[];
  critiqueOutputs: ReviewCritiqueResult[];
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
      clip(reviewer.text, 20_000),
      "```"
    ]),
    ["", "Critique outputs:"],
    input.critiqueOutputs.flatMap((critique) => [
      "",
      `Reviewer: ${critique.reviewer} (${critique.provider}${critique.model ? ` / ${critique.model}` : ""})`,
      "```text",
      clip(critique.text, 20_000),
      "```"
    ])
  ).join("\n");
}

function buildSummarizerPrompt(input: {
  repoFullName: string;
  branchName: string;
  baseBranch: string;
  analyzerText: string;
  reviewerOutputs: ReviewerStageResult[];
  critiqueOutputs: ReviewCritiqueResult[];
  judgeRounds: JudgeStageResult[];
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
    clip(input.analyzerText, 20_000),
    "```",
    "",
    "Reviewer outputs:"
  ].concat(
    input.reviewerOutputs.flatMap((reviewer) => [
      "",
      `Reviewer: ${reviewer.reviewer} (${reviewer.provider}${reviewer.model ? ` / ${reviewer.model}` : ""})`,
      "```text",
      clip(reviewer.text, 20_000),
      "```"
    ]),
    ["", "Critique outputs:"],
    input.critiqueOutputs.flatMap((critique) => [
      "",
      `Round ${critique.round} critique: ${critique.reviewer} (${critique.provider}${critique.model ? ` / ${critique.model}` : ""})`,
      "```text",
      clip(critique.text, 20_000),
      "```"
    ]),
    ["", "Judge outputs:"],
    input.judgeRounds.flatMap((judgeRound) => [
      "",
      `Round ${judgeRound.round} consensus: ${judgeRound.consensusReached ? "reached" : "not reached"}`,
      "```text",
      clip(judgeRound.text, 20_000),
      "```"
    ])
  ).join("\n");
}

function buildArtifactPath(artifactRootPath: string, branchName: string): { absolutePath: string; relativePath: string } {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const safeBranch = branchName.replaceAll("/", "-");
  const relativePath = join("docs", "reviews", safeBranch, `${timestamp}-review.md`);
  return {
    absolutePath: join(artifactRootPath, relativePath),
    relativePath
  };
}

function getRemainingBudget(startTime: number, totalTimeoutMs: number): number {
  return totalTimeoutMs - (Date.now() - startTime);
}

function getStageTimeout(startTime: number, stageTimeoutMs: number, totalTimeoutMs: number, remainingStages: number): number {
  const remainingBudget = getRemainingBudget(startTime, totalTimeoutMs);
  if (remainingBudget <= 0) {
    throw new AdversarialReviewError("PIPELINE_FAILED", `Review pipeline exceeded ${totalTimeoutMs}ms.`);
  }

  const normalizedRemainingStages = Math.max(1, remainingStages);
  const availableForCurrentStage = Math.floor(remainingBudget / normalizedRemainingStages);
  if (availableForCurrentStage <= 0) {
    throw new AdversarialReviewError("PIPELINE_FAILED", `Review pipeline exceeded ${totalTimeoutMs}ms.`);
  }

  return Math.min(stageTimeoutMs, availableForCurrentStage);
}

function findLatestReviewerOutput(
  outputs: ReviewerStageResult[],
  reviewerLabel: string
): ReviewerStageResult | undefined {
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const candidate = outputs[index];
    if (candidate?.reviewer === reviewerLabel) {
      return candidate;
    }
  }

  return undefined;
}

export async function runAdversarialReview(input: {
  db: AppDatabase;
  logger: Logger;
  requestId: number;
  threadId: string;
  repoFullName: string;
  branchName: string;
  worktreePath: string;
  artifactRootPath: string;
  threadHistory: string;
  analyzer: ReviewModelRunner;
  reviewers: ReviewModelRunner[];
  judge: ReviewModelRunner;
  summarizer: ReviewModelRunner;
  stageTimeoutMs: number;
  totalTimeoutMs: number;
  maxConsensusRounds?: number;
}): Promise<AdversarialReviewResult> {
  if (input.reviewers.length < 2) {
    throw new AdversarialReviewError("INSUFFICIENT_REVIEWERS", "Review requires at least 2 configured reviewers.");
  }

  const startTime = Date.now();
  const maxConsensusRounds = Math.max(1, input.maxConsensusRounds ?? 2);
  const checkBudget = (): void => {
    if (Date.now() - startTime > input.totalTimeoutMs) {
      throw new AdversarialReviewError("PIPELINE_FAILED", `Review pipeline exceeded ${input.totalTimeoutMs}ms.`);
    }
  };

  const diff = await getReviewDiff(input.worktreePath, {
    headRef: input.branchName,
    excludePaths: ["docs/reviews/**"]
  });
  if (diff.changedFiles.length === 0 || diff.diffText.trim().length === 0) {
    throw new AdversarialReviewError("EMPTY_DIFF", `No committed changes found on branch \`${input.branchName}\` compared to the default branch. Ask Claude to commit its changes first, then run /review again.`);
  }

  const reviewRun = input.db.createReviewRun({
    requestId: input.requestId,
    threadId: input.threadId,
    branchName: input.branchName,
    status: "running",
    configJson: JSON.stringify({
      analyzer: { provider: input.analyzer.provider, model: input.analyzer.model ?? null },
      reviewers: input.reviewers.map((reviewer) => ({
        provider: reviewer.provider,
        model: reviewer.model ?? null,
        label: reviewer.label
      })),
      judge: { provider: input.judge.provider, model: input.judge.model ?? null, label: input.judge.label },
      summarizer: { provider: input.summarizer.provider, model: input.summarizer.model ?? null },
      stageTimeoutMs: input.stageTimeoutMs,
      totalTimeoutMs: input.totalTimeoutMs,
      maxConsensusRounds
    }),
    diffBase: diff.baseRef,
    diffHead: diff.headSha
  });

  try {
    checkBudget();
    const analyzerPrompt = buildAnalyzerPrompt({
      repoFullName: input.repoFullName,
      branchName: input.branchName,
      threadHistory: input.threadHistory
    });
    const analyzerText = await input.analyzer.run({
      prompt: analyzerPrompt,
      cwd: input.worktreePath,
      timeoutMs: getStageTimeout(startTime, input.stageTimeoutMs, input.totalTimeoutMs, 3),
      ...(input.analyzer.model ? { model: input.analyzer.model } : {})
    });

    const allReviewerOutputs: ReviewerStageResult[] = [];
    const allCritiqueOutputs: ReviewCritiqueResult[] = [];
    const judgeRounds: JudgeStageResult[] = [];
    let activeReviewers = input.reviewers;
    let latestRoundReviews: ReviewerStageResult[] = [];

    for (let round = 1; round <= maxConsensusRounds; round += 1) {
      checkBudget();
      const reviewerResults = await Promise.allSettled(
        activeReviewers.map(async (reviewer) => {
          const priorReview = findLatestReviewerOutput(allReviewerOutputs, reviewer.label);
          const critiqueFeedback = allCritiqueOutputs
            .filter((critique) => critique.round === round - 1 && critique.reviewer !== reviewer.label)
            .map((critique) => `${critique.reviewer}: ${critique.text}`);
          const priorJudge = judgeRounds.at(-1);
          const reviewerGuidance = priorJudge?.reviewerGuidance
            .filter((guidance) => guidance.reviewer === reviewer.label)
            .map((guidance) => guidance.feedback)
            .join("\n");
          const reviewerText = await reviewer.run({
            prompt: buildReviewerPrompt({
              repoFullName: input.repoFullName,
              branchName: input.branchName,
              baseBranch: diff.baseBranch,
              analyzerText,
              changedFiles: diff.changedFiles,
              diffText: diff.diffText,
              reviewerLabel: reviewer.label,
              round,
              ...(priorReview ? { previousReview: priorReview.text } : {}),
              ...(critiqueFeedback.length > 0 ? { critiqueFeedback } : {}),
              ...(priorJudge ? { judgeSummary: [priorJudge.consensusSummary, reviewerGuidance].filter(Boolean).join("\n") } : {})
            }),
            cwd: input.worktreePath,
            timeoutMs: getStageTimeout(startTime, input.stageTimeoutMs, input.totalTimeoutMs, (maxConsensusRounds - round + 1) * 3 + 1),
            ...(reviewer.model ? { model: reviewer.model } : {})
          });

          return {
            round,
            reviewer: reviewer.label,
            provider: reviewer.provider,
            ...(reviewer.model ? { model: reviewer.model } : {}),
            text: reviewerText
          } satisfies ReviewerStageResult;
        })
      );

      const successfulReviewers = reviewerResults
        .filter((result): result is PromiseFulfilledResult<ReviewerStageResult> => result.status === "fulfilled")
        .map((result) => result.value);
      const failedReviewers = reviewerResults.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );

      if (failedReviewers.length > 0) {
        const rejectedMessages = failedReviewers.map((r) =>
          r.reason instanceof Error ? r.reason.message : String(r.reason)
        );

        if (successfulReviewers.length === 0) {
          throw new AdversarialReviewError(
            "INSUFFICIENT_REVIEWERS",
            `All reviewers failed. Failures: ${rejectedMessages.join(" | ") || "unknown reviewer failure"}`
          );
        }

        input.logger.warn(
          {
            round,
            succeeded: successfulReviewers.length,
            failed: failedReviewers.length,
            failures: rejectedMessages
          },
          "Some reviewers failed; continuing with successful reviewers"
        );
      }

      allReviewerOutputs.push(...successfulReviewers);
      latestRoundReviews = successfulReviewers;
      activeReviewers = input.reviewers.filter((reviewer) => successfulReviewers.some((result) => result.reviewer === reviewer.label));

      checkBudget();
      const critiqueSettled = await Promise.allSettled(
        activeReviewers.map(async (reviewer) => {
          const ownReview = successfulReviewers.find((result) => result.reviewer === reviewer.label);
          const peerReviews = successfulReviewers.filter((result) => result.reviewer !== reviewer.label);
          const critiqueText = await reviewer.run({
            prompt: buildCritiquePrompt({
              repoFullName: input.repoFullName,
              branchName: input.branchName,
              baseBranch: diff.baseBranch,
              reviewerLabel: reviewer.label,
              round,
              ownReview: ownReview?.text ?? "",
              peerReviews
            }),
            cwd: input.worktreePath,
            timeoutMs: getStageTimeout(startTime, input.stageTimeoutMs, input.totalTimeoutMs, (maxConsensusRounds - round + 1) * 2 + 1),
            ...(reviewer.model ? { model: reviewer.model } : {})
          });

          return {
            round,
            reviewer: reviewer.label,
            provider: reviewer.provider,
            ...(reviewer.model ? { model: reviewer.model } : {}),
            text: critiqueText
          } satisfies ReviewCritiqueResult;
        })
      );
      const critiqueResults = critiqueSettled
        .filter((result): result is PromiseFulfilledResult<ReviewCritiqueResult> => result.status === "fulfilled")
        .map((result) => result.value);
      const failedCritiques = critiqueSettled.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (failedCritiques.length > 0) {
        input.logger.warn(
          {
            round,
            succeeded: critiqueResults.length,
            failed: failedCritiques.length,
            failures: failedCritiques.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)))
          },
          "Some critiques failed; continuing with successful critiques"
        );
      }
      allCritiqueOutputs.push(...critiqueResults);
      const successfulCritiqueLabels = new Set(critiqueResults.map((c) => c.reviewer));
      activeReviewers = activeReviewers.filter((reviewer) => successfulCritiqueLabels.has(reviewer.label));

      if (activeReviewers.length === 0) {
        input.logger.warn(
          { round },
          "All critiques failed; no active reviewers remain. Proceeding to summarizer with collected data."
        );
        break;
      }

      checkBudget();
      const judgeRawText = await input.judge.run({
        prompt: buildJudgePrompt({
          repoFullName: input.repoFullName,
          branchName: input.branchName,
          baseBranch: diff.baseBranch,
          round,
          reviewerOutputs: successfulReviewers,
          critiqueOutputs: critiqueResults
        }),
        cwd: input.worktreePath,
        timeoutMs: getStageTimeout(startTime, input.stageTimeoutMs, input.totalTimeoutMs, (maxConsensusRounds - round + 1) + 1),
        ...(input.judge.model ? { model: input.judge.model } : {})
      });
      const judgeDecision = parseJudgeDecision(judgeRawText);
      judgeRounds.push({
        round,
        text: judgeRawText,
        consensusReached: judgeDecision.consensusReached,
        consensusSummary: judgeDecision.consensusSummary,
        reviewerGuidance: judgeDecision.reviewerGuidance
      });

      if (judgeDecision.consensusReached) {
        break;
      }
    }

    checkBudget();
    const summarizerRawText = await input.summarizer.run({
      prompt: buildSummarizerPrompt({
        repoFullName: input.repoFullName,
        branchName: input.branchName,
        baseBranch: diff.baseBranch,
        analyzerText,
        reviewerOutputs: allReviewerOutputs,
        critiqueOutputs: allCritiqueOutputs,
        judgeRounds
      }),
      cwd: input.worktreePath,
      timeoutMs: getStageTimeout(startTime, input.stageTimeoutMs, input.totalTimeoutMs, 1),
      ...(input.summarizer.model ? { model: input.summarizer.model } : {})
    });
    const summary = parseStructuredSummary(summarizerRawText);
    const summaryMarkdown = renderReviewMarkdown({
      requestId: input.requestId,
      branchName: input.branchName,
      baseBranch: diff.baseRef,
      diffHeadSha: diff.headSha,
      changedFiles: diff.changedFiles,
      analyzerText,
      reviewers: allReviewerOutputs,
      critiques: allCritiqueOutputs,
      judgeRounds,
      summary
    });
    const artifactPath = buildArtifactPath(input.artifactRootPath, input.branchName);
    await mkdir(dirname(artifactPath.absolutePath), { recursive: true });
    await writeFile(artifactPath.absolutePath, `${summaryMarkdown}\n`, "utf8");

    const rawResult = {
      analyzer: { text: analyzerText },
      reviewers: allReviewerOutputs,
      critiques: allCritiqueOutputs,
      judgeRounds,
      summarizerRawText
    };
    input.db.completeReviewRun({
      reviewRunId: reviewRun.id,
      status: "completed",
      finalVerdict: summary.verdict,
      summaryMarkdown,
      rawResultJson: JSON.stringify(rawResult),
      artifactPath: artifactPath.relativePath
    });

    return {
      reviewRunId: reviewRun.id,
      baseBranch: diff.baseBranch,
      diffBaseRef: diff.baseRef,
      diffHeadSha: diff.headSha,
      changedFiles: diff.changedFiles,
      reviewersSucceeded: latestRoundReviews.length,
      reviewersAttempted: input.reviewers.length,
      summary,
      summaryMarkdown,
      artifactPath: artifactPath.relativePath,
      rawResult
    };
  } catch (error) {
    input.db.completeReviewRun({
      reviewRunId: reviewRun.id,
      status: "failed",
      finalVerdict: null,
      summaryMarkdown: null,
      rawResultJson: JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      }),
      artifactPath: null
    });
    input.logger.error({ error, reviewRunId: reviewRun.id, requestId: input.requestId }, "Adversarial review failed");
    if (error instanceof AdversarialReviewError) {
      throw error;
    }
    throw new AdversarialReviewError("PIPELINE_FAILED", error instanceof Error ? error.message : "Review pipeline failed.");
  }
}
