import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

vi.mock("../src/services/gitWorkspaceService.js", () => ({
  getReviewDiff: vi.fn()
}));

const { getReviewDiff } = await import("../src/services/gitWorkspaceService.js");
const mockGetReviewDiff = vi.mocked(getReviewDiff);

const {
  parseStructuredSummary,
  renderReviewMarkdown,
  runAdversarialReview
} = await import("../src/services/adversarialReviewService.js");

describe("adversarialReviewService", () => {
  let tempRoot: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    tempRoot = await mkdtemp(join(tmpdir(), "adversarial-review-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("parses structured JSON wrapped in a code fence", () => {
    const summary = parseStructuredSummary(`\`\`\`json
{
  "executiveSummary": "Looks good overall.",
  "blockingIssues": [{"title":"Fix queueing","rationale":"Queue state is not asserted.","file":"src/discord/bot.ts"}],
  "nonBlockingIssues": [{"title":"Add docs","rationale":"The help text is outdated."}],
  "missingTests": ["Add /review happy path coverage."],
  "disputedIssues": ["A weak naming complaint was rejected."],
  "verdict": "revise"
}
\`\`\``);

    expect(summary).toEqual({
      executiveSummary: "Looks good overall.",
      blockingIssues: [
        {
          title: "Fix queueing",
          rationale: "Queue state is not asserted.",
          severity: "blocking",
          file: "src/discord/bot.ts"
        }
      ],
      nonBlockingIssues: [
        {
          title: "Add docs",
          rationale: "The help text is outdated.",
          severity: "non_blocking"
        }
      ],
      missingTests: ["Add /review happy path coverage."],
      disputedIssues: ["A weak naming complaint was rejected."],
      verdict: "revise"
    });
  });

  it("falls back cleanly when the summarizer returns malformed text", () => {
    const summary = parseStructuredSummary("ready_for_pr\n\nThis branch looks fine but the JSON is malformed.");

    expect(summary.blockingIssues).toEqual([]);
    expect(summary.nonBlockingIssues).toEqual([]);
    expect(summary.missingTests).toEqual([]);
    expect(summary.disputedIssues).toEqual([]);
    expect(summary.verdict).toBe("ready_for_pr");
    expect(summary.executiveSummary).toContain("This branch looks fine");
  });

  it("uses a concise first sentence for long malformed summarizer output", () => {
    const summary = parseStructuredSummary(
      "revise\n\nThe queue permission check is missing, so any thread participant can trigger /review. "
      + "Additional repeated filler text ".repeat(80)
    );

    expect(summary.verdict).toBe("revise");
    expect(summary.executiveSummary).toBe(
      "revise The queue permission check is missing, so any thread participant can trigger /review."
    );
    expect(summary.executiveSummary.length).toBeLessThan(160);
  });

  it("runs the full review pipeline, tolerates one reviewer failure, and writes a stable artifact", async () => {
    mockGetReviewDiff.mockResolvedValue({
      baseBranch: "main",
      baseRef: "origin/main",
      headRef: "ask/51-123",
      headSha: "deadbeef",
      changedFiles: ["src/discord/bot.ts"],
      diffText: "diff --git a/src/discord/bot.ts b/src/discord/bot.ts\n"
    });

    const runs: Array<{ label: string; timeoutMs: number }> = [];
    const analyzer = {
      provider: "claude" as const,
      model: "claude-sonnet-4",
      label: "Claude",
      run: vi.fn(async ({ timeoutMs }: { timeoutMs: number }) => {
        runs.push({ label: "analyzer", timeoutMs });
        return "Summary\n- queue behavior\nRisk Areas\n- review permissions";
      })
    };
    const reviewers = [
      {
        provider: "claude" as const,
        model: "claude-sonnet-4",
        label: "Claude",
        run: vi.fn(async ({ timeoutMs }: { timeoutMs: number }) => {
          runs.push({ label: "reviewer-1", timeoutMs });
          return "Blocking Issues\n- None";
        })
      },
      {
        provider: "codex" as const,
        model: "o4-mini",
        label: "Codex",
        run: vi.fn(async ({ timeoutMs }: { timeoutMs: number }) => {
          runs.push({ label: "reviewer-2", timeoutMs });
          throw new Error(`timed out at ${timeoutMs}`);
        })
      },
      {
        provider: "gemini" as const,
        model: "gemini-2.5-pro",
        label: "Gemini",
        run: vi.fn(async ({ timeoutMs }: { timeoutMs: number }) => {
          runs.push({ label: "reviewer-3", timeoutMs });
          return "Missing Tests\n- Add handleReview permission coverage";
        })
      }
    ];
    const summarizer = {
      provider: "gemini" as const,
      model: "gemini-2.5-pro",
      label: "Gemini",
      run: vi.fn(async ({ timeoutMs }: { timeoutMs: number }) => {
        runs.push({ label: "summarizer", timeoutMs });
        return JSON.stringify({
          executiveSummary: "Two reviewers succeeded and one failed.",
          blockingIssues: [],
          nonBlockingIssues: [
            {
              title: "Document /review",
              rationale: "Users need help text for the new command."
            }
          ],
          missingTests: ["Add handleReview permission coverage."],
          disputedIssues: [],
          verdict: "revise"
        });
      })
    };
    const createReviewRun = vi.fn().mockReturnValue({ id: 7 });
    const completeReviewRun = vi.fn();

    const result = await runAdversarialReview({
      db: {
        createReviewRun,
        completeReviewRun
      } as never,
      logger: pino({ level: "silent" }),
      requestId: 51,
      threadId: "thread-51",
      repoFullName: "digitumdei/actuarius",
      branchName: "ask/51-123",
      worktreePath: join(tempRoot, "worktree"),
      artifactRootPath: join(tempRoot, "artifacts"),
      analyzer,
      reviewers,
      summarizer,
      stageTimeoutMs: 1_000,
      totalTimeoutMs: 2_500
    });

    expect(result.reviewRunId).toBe(7);
    expect(result.reviewersSucceeded).toBe(2);
    expect(result.reviewersAttempted).toBe(3);
    expect(result.summary.verdict).toBe("revise");
    expect(result.artifactPath).toMatch(/^docs\/reviews\/51\/.+-review\.md$/);
    expect(await readFile(join(tempRoot, "artifacts", result.artifactPath), "utf8")).toContain("# Adversarial Review");
    expect(createReviewRun).toHaveBeenCalledOnce();
    expect(completeReviewRun).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewRunId: 7,
        status: "completed",
        finalVerdict: "revise",
        artifactPath: result.artifactPath
      })
    );
    expect(runs.map((entry) => entry.label)).toEqual([
      "analyzer",
      "reviewer-1",
      "reviewer-2",
      "reviewer-3",
      "summarizer"
    ]);
  });
});

describe("renderReviewMarkdown", () => {
  it("renders a structured markdown artifact", () => {
    const markdown = renderReviewMarkdown({
      requestId: 51,
      branchName: "ask/51-123",
      baseBranch: "origin/main",
      diffHeadSha: "abc123",
      changedFiles: ["src/discord/bot.ts", "src/services/adversarialReviewService.ts"],
      analyzerText: "Summary\n- command wiring\nRisk Areas\n- parser",
      reviewers: [
        {
          reviewer: "Claude",
          provider: "claude",
          text: "Blocking Issues\n- none"
        },
        {
          reviewer: "Codex",
          provider: "codex",
          model: "o4-mini",
          text: "Missing Tests\n- add queue coverage"
        }
      ],
      summary: {
        executiveSummary: "The implementation is close but needs more test coverage.",
        blockingIssues: [
          {
            title: "Missing queue handling assertion",
            severity: "blocking",
            rationale: "The command must share the existing request queue."
          }
        ],
        nonBlockingIssues: [],
        missingTests: ["Add /review happy path coverage."],
        disputedIssues: [],
        verdict: "revise"
      }
    });

    expect(markdown).toContain("# Adversarial Review");
    expect(markdown).toContain("Verdict: revise");
    expect(markdown).toContain("Missing queue handling assertion");
    expect(markdown).toContain("### Codex (codex / o4-mini)");
  });
});
