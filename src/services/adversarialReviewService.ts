import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  reviewer: string;
  provider: AiProvider;
  model?: string;
  text: string;
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
      ? parsed.missingTests.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    const disputedIssues = Array.isArray(parsed.disputedIssues)
      ? parsed.disputedIssues.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
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
      verdict
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

  return lines.join("\n");
}

function buildAnalyzerPrompt(input: {
  repoFullName: string;
  branchName: string;
  baseBranch: string;
  changedFiles: string[];
  diffText: string;
}): string {
  return [
    `You are the analyzer for an adversarial code review of ${input.repoFullName}.`,
    `Review branch: ${input.branchName}`,
    `Diff base: ${input.baseBranch}`,
    "Focus on what changed, risk areas, and the code paths most likely to hide regressions.",
    "Return plain text with these headings: Summary, Risk Areas, Suggested Review Focus.",
    "",
    "Changed files:",
    ...(input.changedFiles.length > 0 ? input.changedFiles.map((file) => `- ${file}`) : ["- (none)"]),
    "",
    "Diff:",
    "```diff",
    clip(input.diffText, 120_000),
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
}): string {
  return [
    `You are ${input.reviewerLabel}, an adversarial reviewer for ${input.repoFullName}.`,
    `Review branch: ${input.branchName}`,
    `Diff base: ${input.baseBranch}`,
    "Be skeptical. Do not assume the implementation is correct. Look for bugs, regressions, missing tests, and weak reasoning.",
    "Do not soften criticism to agree with prior analysis. If a concern is weak, say so plainly. If the change looks solid, say that too.",
    "Return plain text with these headings: Blocking Issues, Non-Blocking Issues, Missing Tests, Confidence.",
    "",
    "Analyzer notes:",
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
  ].join("\n");
}

function buildSummarizerPrompt(input: {
  repoFullName: string;
  branchName: string;
  baseBranch: string;
  analyzerText: string;
  reviewerOutputs: ReviewerStageResult[];
}): string {
  return [
    `You are the neutral summarizer for an adversarial code review of ${input.repoFullName}.`,
    `Review branch: ${input.branchName}`,
    `Diff base: ${input.baseBranch}`,
    "Synthesize the analyzer and reviewer outputs into a final verdict.",
    "Return JSON only with this exact shape:",
    "{",
    '  "executiveSummary": "string",',
    '  "blockingIssues": [{"title":"string","rationale":"string","file":"optional path"}],',
    '  "nonBlockingIssues": [{"title":"string","rationale":"string","file":"optional path"}],',
    '  "missingTests": ["string"],',
    '  "disputedIssues": ["string"],',
    '  "verdict": "ready_for_pr" | "revise"',
    "}",
    "Use `ready_for_pr` only if there are no unresolved blocking issues.",
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
    ])
  ).join("\n");
}

function buildArtifactPath(artifactRootPath: string, requestId: number): { absolutePath: string; relativePath: string } {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const relativePath = join("docs", "reviews", String(requestId), `${timestamp}-review.md`);
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

  const reservedForLaterStages = Math.max(0, remainingStages - 1);
  const availableForCurrentStage = remainingBudget - reservedForLaterStages;
  if (availableForCurrentStage <= 0) {
    throw new AdversarialReviewError("PIPELINE_FAILED", `Review pipeline exceeded ${totalTimeoutMs}ms.`);
  }

  return Math.min(stageTimeoutMs, availableForCurrentStage);
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
  analyzer: ReviewModelRunner;
  reviewers: ReviewModelRunner[];
  summarizer: ReviewModelRunner;
  stageTimeoutMs: number;
  totalTimeoutMs: number;
}): Promise<AdversarialReviewResult> {
  if (input.reviewers.length < 2) {
    throw new AdversarialReviewError("INSUFFICIENT_REVIEWERS", "Review requires at least 2 configured reviewers.");
  }

  const startTime = Date.now();
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
    throw new AdversarialReviewError("EMPTY_DIFF", "No reviewable diff found between the request branch and the default branch.");
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
      summarizer: { provider: input.summarizer.provider, model: input.summarizer.model ?? null },
      stageTimeoutMs: input.stageTimeoutMs,
      totalTimeoutMs: input.totalTimeoutMs
    }),
    diffBase: diff.baseRef,
    diffHead: diff.headSha
  });

  try {
    checkBudget();
    const analyzerPrompt = buildAnalyzerPrompt({
      repoFullName: input.repoFullName,
      branchName: input.branchName,
      baseBranch: diff.baseBranch,
      changedFiles: diff.changedFiles,
      diffText: diff.diffText
    });
    const analyzerText = await input.analyzer.run({
      prompt: analyzerPrompt,
      cwd: input.worktreePath,
      timeoutMs: getStageTimeout(startTime, input.stageTimeoutMs, input.totalTimeoutMs, 3),
      ...(input.analyzer.model ? { model: input.analyzer.model } : {})
    });

    checkBudget();
    const reviewerResults = await Promise.allSettled(
      input.reviewers.map(async (reviewer) => {
        const reviewerText = await reviewer.run({
          prompt: buildReviewerPrompt({
            repoFullName: input.repoFullName,
            branchName: input.branchName,
            baseBranch: diff.baseBranch,
            analyzerText,
            changedFiles: diff.changedFiles,
            diffText: diff.diffText,
            reviewerLabel: reviewer.label
          }),
          cwd: input.worktreePath,
          timeoutMs: getStageTimeout(startTime, input.stageTimeoutMs, input.totalTimeoutMs, 2),
          ...(reviewer.model ? { model: reviewer.model } : {})
        });

        return {
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
    if (successfulReviewers.length < 2) {
      const rejectedMessages = reviewerResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
      throw new AdversarialReviewError(
        "INSUFFICIENT_REVIEWERS",
        `Review requires at least 2 successful reviewers. Failures: ${rejectedMessages.join(" | ") || "unknown reviewer failure"}`
      );
    }

    checkBudget();
    const summarizerRawText = await input.summarizer.run({
      prompt: buildSummarizerPrompt({
        repoFullName: input.repoFullName,
        branchName: input.branchName,
        baseBranch: diff.baseBranch,
        analyzerText,
        reviewerOutputs: successfulReviewers
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
      reviewers: successfulReviewers,
      summary
    });
    const artifactPath = buildArtifactPath(input.artifactRootPath, input.requestId);
    await mkdir(join(input.artifactRootPath, "docs", "reviews", String(input.requestId)), { recursive: true });
    await writeFile(artifactPath.absolutePath, `${summaryMarkdown}\n`, "utf8");

    const rawResult = {
      analyzer: { text: analyzerText },
      reviewers: successfulReviewers,
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
      reviewersSucceeded: successfulReviewers.length,
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
