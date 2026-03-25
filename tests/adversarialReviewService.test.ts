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
  "outstandingConcerns": ["One reviewer still wants queue load testing."],
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
      outstandingConcerns: ["One reviewer still wants queue load testing."],
      verdict: "revise"
    });
  });

  it("falls back cleanly when the summarizer returns malformed text", () => {
    const summary = parseStructuredSummary("ready_for_pr\n\nThis branch looks fine but the JSON is malformed.");

    expect(summary.blockingIssues).toEqual([]);
    expect(summary.nonBlockingIssues).toEqual([]);
    expect(summary.missingTests).toEqual([]);
    expect(summary.disputedIssues).toEqual([]);
    expect(summary.outstandingConcerns).toEqual([]);
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
    expect(summary.outstandingConcerns).toEqual([]);
  });

  it("divides the remaining budget across the remaining stages", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      mockGetReviewDiff.mockResolvedValue({
        baseBranch: "main",
        baseRef: "origin/main",
        headRef: "ask/51-123",
        headSha: "deadbeef",
        changedFiles: ["src/discord/bot.ts"],
        diffText: "diff --git a/src/discord/bot.ts b/src/discord/bot.ts\n"
      });

      const timeouts: Array<{ label: string; timeoutMs: number }> = [];
      const analyzer = {
        provider: "claude" as const,
        label: "Claude",
        run: vi.fn(async ({ timeoutMs }: { timeoutMs: number }) => {
          timeouts.push({ label: "analyzer", timeoutMs });
          return "Summary\n- queue behavior";
        })
      };
      const reviewers = [
        {
          provider: "claude" as const,
          label: "Claude",
          run: vi.fn(async ({ timeoutMs }: { timeoutMs: number }) => {
            timeouts.push({ label: "reviewer-1", timeoutMs });
            return "Blocking Issues\n- None";
          })
        },
        {
          provider: "gemini" as const,
          label: "Gemini",
          run: vi.fn(async ({ timeoutMs }: { timeoutMs: number }) => {
            timeouts.push({ label: "reviewer-2", timeoutMs });
            return "Blocking Issues\n- None";
          })
        }
      ];
      const judge = {
        provider: "codex" as const,
        label: "Codex",
        run: vi.fn(async ({ timeoutMs }: { timeoutMs: number }) => {
          timeouts.push({ label: "judge", timeoutMs });
          return JSON.stringify({
            consensusReached: true,
            consensusSummary: "Consensus reached.",
            reviewerGuidance: []
          });
        })
      };
      const summarizer = {
        provider: "gemini" as const,
        label: "Gemini",
        run: vi.fn(async ({ timeoutMs }: { timeoutMs: number }) => {
          timeouts.push({ label: "summarizer", timeoutMs });
          return JSON.stringify({
            executiveSummary: "Looks good.",
            blockingIssues: [],
            nonBlockingIssues: [],
            missingTests: [],
            disputedIssues: [],
            outstandingConcerns: [],
            verdict: "ready_for_pr"
          });
        })
      };

      await runAdversarialReview({
        db: {
          createReviewRun: vi.fn().mockReturnValue({ id: 9 }),
          completeReviewRun: vi.fn()
        } as never,
        logger: pino({ level: "silent" }),
        requestId: 51,
        threadId: "thread-51",
        repoFullName: "digitumdei/actuarius",
        branchName: "ask/51-123",
        worktreePath: join(tempRoot, "worktree"),
        artifactRootPath: join(tempRoot, "artifacts"),
        threadHistory: "[User]: Add feature X\n\n[Assistant]: Done, committed.",
        analyzer,
        reviewers,
        judge,
        summarizer,
        stageTimeoutMs: 1_000,
        totalTimeoutMs: 900,
        maxConsensusRounds: 1
      });

      expect(timeouts).toEqual([
        { label: "analyzer", timeoutMs: 300 },
        { label: "reviewer-1", timeoutMs: 225 },
        { label: "reviewer-2", timeoutMs: 225 },
        { label: "reviewer-1", timeoutMs: 300 },
        { label: "reviewer-2", timeoutMs: 300 },
        { label: "judge", timeoutMs: 450 },
        { label: "summarizer", timeoutMs: 900 }
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("runs the full multi-round review pipeline, reaches consensus, and writes a stable artifact", async () => {
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
    const judge = {
      provider: "claude" as const,
      model: "claude-sonnet-4",
      label: "Claude",
      run: vi
        .fn()
        .mockImplementationOnce(async ({ timeoutMs }: { timeoutMs: number }) => {
          runs.push({ label: "judge-1", timeoutMs });
          return JSON.stringify({
            consensusReached: false,
            consensusSummary: "Gemini and Claude disagree on whether the permission concern is blocking.",
            reviewerGuidance: [
              {
                reviewer: "Claude",
                feedback: "State whether the permission concern is blocking and why."
              },
              {
                reviewer: "Gemini",
                feedback: "Clarify whether the missing test is a blocker or non-blocker."
              }
            ]
          });
        })
        .mockImplementationOnce(async ({ timeoutMs }: { timeoutMs: number }) => {
          runs.push({ label: "judge-2", timeoutMs });
          return JSON.stringify({
            consensusReached: true,
            consensusSummary: "Consensus reached: add permission coverage, but the branch is otherwise sound.",
            reviewerGuidance: []
          });
        })
    };
    const summarizer = {
      provider: "gemini" as const,
      model: "gemini-2.5-pro",
      label: "Gemini",
      run: vi.fn(async ({ timeoutMs }: { timeoutMs: number }) => {
        runs.push({ label: "summarizer", timeoutMs });
        return JSON.stringify({
          executiveSummary: "Two reviewers converged after one follow-up round.",
          blockingIssues: [],
          nonBlockingIssues: [
            {
              title: "Add permission coverage",
              rationale: "Consensus settled on a missing regression test for the review permission gate."
            }
          ],
          missingTests: ["Add handleReview permission coverage."],
          disputedIssues: ["Claude initially rated the permission concern as blocking before the second round resolved it."],
          outstandingConcerns: ["Gemini still wants a thread-level integration test for the queue interaction."],
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
      threadHistory: "[User]: Add feature X\n\n[Assistant]: Done, committed.",
      analyzer,
      reviewers,
      judge,
      summarizer,
      stageTimeoutMs: 1_000,
      totalTimeoutMs: 5_000,
      maxConsensusRounds: 2
    });

    expect(result.reviewRunId).toBe(7);
    expect(result.reviewersSucceeded).toBe(2);
    expect(result.reviewersAttempted).toBe(3);
    expect(result.summary.verdict).toBe("revise");
    expect(result.summary.outstandingConcerns).toEqual([
      "Gemini still wants a thread-level integration test for the queue interaction."
    ]);
    expect(result.artifactPath).toMatch(/docs[\\/]reviews[\\/]ask-51-123[\\/].+-review\.md$/);
    const artifact = await readFile(join(tempRoot, "artifacts", result.artifactPath), "utf8");
    expect(artifact).toContain("# Adversarial Review");
    expect(artifact).toContain("## Critique Outputs");
    expect(artifact).toContain("## Judge Outputs");
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
      "reviewer-1",
      "reviewer-3",
      "judge-1",
      "reviewer-1",
      "reviewer-3",
      "reviewer-1",
      "reviewer-3",
      "judge-2",
      "summarizer"
    ]);
    expect(result.rawResult.reviewers.map((review) => `${review.round}:${review.reviewer}`)).toEqual([
      "1:Claude",
      "1:Gemini",
      "2:Claude",
      "2:Gemini"
    ]);
    expect(result.rawResult.critiques.map((critique) => `${critique.round}:${critique.reviewer}`)).toEqual([
      "1:Claude",
      "1:Gemini",
      "2:Claude",
      "2:Gemini"
    ]);
    expect(result.rawResult.judgeRounds).toHaveLength(2);
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
          round: 1,
          reviewer: "Claude",
          provider: "claude",
          text: "Blocking Issues\n- none"
        },
        {
          round: 2,
          reviewer: "Codex",
          provider: "codex",
          model: "o4-mini",
          text: "Missing Tests\n- add queue coverage"
        }
      ],
      critiques: [
        {
          round: 1,
          reviewer: "Gemini",
          provider: "gemini",
          text: "Valid Comments\n- Queue concern is valid"
        }
      ],
      judgeRounds: [
        {
          round: 1,
          text: "{\"consensusReached\":false}",
          consensusReached: false,
          consensusSummary: "Consensus not yet reached.",
          reviewerGuidance: [
            {
              reviewer: "Claude",
              feedback: "Clarify whether the queue issue is blocking."
            }
          ]
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
        outstandingConcerns: ["One reviewer still wants broader queue integration coverage."],
        verdict: "revise"
      }
    });

    expect(markdown).toContain("# Adversarial Review");
    expect(markdown).toContain("Verdict: revise");
    expect(markdown).toContain("Missing queue handling assertion");
    expect(markdown).toContain("### Codex (codex / o4-mini)");
    expect(markdown).toContain("## Critique Outputs");
    expect(markdown).toContain("## Judge Outputs");
    expect(markdown).toContain("## Outstanding Concerns");
  });
});
