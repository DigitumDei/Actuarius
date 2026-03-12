# Adversarial Review Analysis for Actuarius

## Goal

Add an Actuarius command that runs an adversarial, multi-model code review after implementation is complete and before a PR is opened. The command should work against the request worktree that `/ask` already creates, produce a structured review artifact, and gate the later PR step on review completion.

## Repositories Reviewed

- Actuarius: https://github.com/DigitumDei/Actuarius
- Magpie: https://github.com/liliu-z/magpie

## Executive Summary

Magpie is not just "multiple models reviewing code." Its useful design is the orchestration around those models:

- a dedicated analyzer step before debate
- same-round reviewers seeing the same evidence
- reviewers running in parallel per round
- prompts that explicitly tell reviewers to challenge each other
- convergence checks to stop early
- a neutral summarizer that turns debate into action items

Actuarius already has most of the platform pieces needed to implement a narrower version of this:

- Discord slash commands and thread-based UX in [src/discord/commands.ts](/data/repos/.worktrees/digitumdei/actuarius/70/src/discord/commands.ts) and [src/discord/bot.ts](/data/repos/.worktrees/digitumdei/actuarius/70/src/discord/bot.ts)
- isolated git worktrees in [src/services/requestWorktreeService.ts](/data/repos/.worktrees/digitumdei/actuarius/70/src/services/requestWorktreeService.ts)
- per-guild queued execution in [src/services/requestExecutionQueue.ts](/data/repos/.worktrees/digitumdei/actuarius/70/src/services/requestExecutionQueue.ts)
- provider CLI execution for Claude, Codex, and Gemini in [src/services/claudeExecutionService.ts](/data/repos/.worktrees/digitumdei/actuarius/70/src/services/claudeExecutionService.ts), [src/services/codexExecutionService.ts](/data/repos/.worktrees/digitumdei/actuarius/70/src/services/codexExecutionService.ts), and [src/services/geminiExecutionService.ts](/data/repos/.worktrees/digitumdei/actuarius/70/src/services/geminiExecutionService.ts)
- SQLite persistence in [src/db/database.ts](/data/repos/.worktrees/digitumdei/actuarius/70/src/db/database.ts)

The right implementation for Actuarius is not to copy Magpie as a separate generic CLI. The right move is to add an Actuarius-native review workflow that reuses the existing request thread, worktree, provider runners, and database.

## What Magpie Does That Matters

Relevant parts of Magpie's design:

- `review` command builds a review target from PR diff, local diff, branch diff, or explicit files.
- provider abstraction allows the same orchestration to run against different model backends.
- `DebateOrchestrator` runs:
  - analysis first
  - optional context gathering
  - one or more debate rounds
  - reviewer summaries
  - final summarization
  - structured issue extraction
- reviewers in the same round run in parallel from the same prior state, which avoids unfair "later reviewer" advantage.
- round 2+ prompts explicitly ask reviewers to find what others missed and challenge weak arguments.
- convergence checking prevents unnecessary extra rounds.
- session/state handling lets reviews be resumed/exported.

For Actuarius, the most valuable Magpie ideas are:

1. analyzer -> debate -> summarizer pipeline
2. fair same-round parallelism
3. anti-sycophancy prompts
4. structured output suitable for a later PR description or checklist

The least important parts for an initial Actuarius implementation are:

- generic standalone CLI UX
- full session resume/export machinery
- repository-wide architecture review modes
- interactive terminal flows

## Current Actuarius Fit

### What Actuarius already has

- A request lifecycle with persistent records and thread IDs in [src/db/database.ts](/data/repos/.worktrees/digitumdei/actuarius/70/src/db/database.ts)
- Thread-based follow-up context reconstruction in [src/discord/bot.ts](/data/repos/.worktrees/digitumdei/actuarius/70/src/discord/bot.ts)
- Reusable worktree state (`worktree_path`, `branch_name`) already attached to requests
- Provider selection at guild level via `/model-select`
- Safe repository sync and worktree creation

This is enough to support a review flow that runs against the completed code in the existing request branch.

### What Actuarius does not yet have

- a concept of "implementation complete"
- a distinct review command or review state machine
- multi-provider execution in one workflow
- structured review persistence
- PR creation flow to gate after review

## Recommended User Flow

The cleanest flow is thread-centric:

1. User runs `/ask` and iterates until the code is ready.
2. User runs a new command from the same request thread, for example `/review`.
3. Actuarius inspects the thread's tracked worktree and branch.
4. Actuarius computes the review scope from `master...<request-branch>`.
5. Actuarius runs:
   - analyzer pass
   - reviewer round 1 in parallel
   - reviewer round 2 in parallel if needed
   - summarizer pass
6. Actuarius posts:
   - an executive summary
   - blocking issues
   - disagreements
   - recommended next action: `revise` or `ready for PR`
7. Only after that should a later PR command be allowed, for example `/pr`.

This keeps the review coupled to the exact branch the implementation produced. It also avoids inventing a separate repo-wide review UX.

## Proposed Commands

### ` /review `

Run adversarial review for the current request thread.

Suggested options:

- `depth`: `quick` or `full`
- `rounds`: optional override, default `2`
- `reviewers`: optional explicit provider list, default server policy

Expected behavior:

- must be run inside a request thread
- requires a tracked branch, not a detached worktree
- fails if the request is still running
- compares request branch against `master`
- posts progress updates in the thread
- persists structured results

### Later follow-up commands

Not required for v1, but the design should leave room for:

- `/review-status`
- `/review-rerun`
- `/pr`

## Architecture Proposal

### 1. Add a dedicated review orchestration service

Create something like:

- `src/services/adversarialReviewService.ts`

Responsibilities:

- compute git diff for the request branch
- construct analyzer/reviewer/summarizer prompts
- run providers in the required order
- execute reviewers in parallel per round
- merge outputs into a stable result object

This should be a separate service, not more logic folded into `ActuariusBot`.

### 2. Reuse the existing provider execution layer

Actuarius already has single-shot provider runners. That is enough for v1.

Instead of copying Magpie's provider abstraction, add a thin internal abstraction on top of:

- `runClaudeRequest`
- `runCodexRequest`
- `runGeminiRequest`

Example shape:

```ts
interface ReviewModelRunner {
  provider: "claude" | "codex" | "gemini";
  model?: string;
  run(prompt: string, cwd: string, timeoutMs: number): Promise<string>;
}
```

Magpie needs streaming and session-aware providers because it is a standalone multi-turn CLI. Actuarius does not need that complexity for an initial review gate.

### 3. Add git diff and review-scope helpers

Actuarius currently syncs repos and manages worktrees, but it does not yet compute the review diff.

Add helpers in the git layer for:

- `git diff master...<branch>`
- changed file list
- optional line range extraction for future inline PR comments

This should likely live near [src/services/gitWorkspaceService.ts](/data/repos/.worktrees/digitumdei/actuarius/70/src/services/gitWorkspaceService.ts).

### 4. Persist review state separately from request state

Do not overload `requests.status` for debate state. Add a new table, for example:

```sql
CREATE TABLE review_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  diff_base TEXT NOT NULL DEFAULT 'master',
  diff_head TEXT NOT NULL,
  final_verdict TEXT,
  summary_markdown TEXT,
  raw_result_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
);
```

Optional child table if individual reviewer outputs need querying later:

```sql
CREATE TABLE review_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_run_id INTEGER NOT NULL,
  round_number INTEGER NOT NULL,
  reviewer_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (review_run_id) REFERENCES review_runs(id) ON DELETE CASCADE
);
```

For v1, `raw_result_json` may be enough.

### 5. Add guild-level review configuration

Actuarius currently stores one active provider/model for `/ask`. Adversarial review needs multiple reviewer identities.

Add a guild-scoped review config table or JSON blob with:

- enabled reviewers
- analyzer provider/model
- summarizer provider/model
- default max rounds
- convergence enabled flag
- severity threshold that blocks PR creation

Example:

```json
{
  "analyzer": { "provider": "claude", "model": "claude-opus-4-5" },
  "reviewers": [
    { "id": "claude", "provider": "claude", "model": "claude-opus-4-5" },
    { "id": "codex", "provider": "codex", "model": "o4-mini" },
    { "id": "gemini", "provider": "gemini", "model": "gemini-2.0-flash" }
  ],
  "summarizer": { "provider": "claude", "model": "claude-opus-4-5" },
  "maxRounds": 2,
  "blockOnSeverity": "high"
}
```

## Review Pipeline Design

### Stage 1: Gather review input

Input should be deterministic and shared across all reviewers:

- request prompt
- latest code in the request worktree
- git diff vs `master`
- changed file list
- optional short thread summary

This mirrors Magpie's "same evidence for same round" design and avoids one model seeing more than another.

### Stage 2: Analyzer

Run one model first to produce:

- concise change summary
- likely risk areas
- files/functions needing special attention

The analyzer output becomes shared context for all reviewers. This is one of the best ideas in Magpie and is cheap to copy.

### Stage 3: Reviewer round 1

Run 2-3 reviewers in parallel.

Prompt shape:

- review every changed file
- focus on correctness, security, architecture, simplicity
- return:
  - verdict
  - blocking issues
  - non-blocking issues
  - tests missing
  - files reviewed with no issues

### Stage 4: Reviewer round 2

Only if needed.

Each reviewer sees:

- analyzer output
- all round 1 reviews from the other reviewers

Prompt them to:

- challenge weak claims
- confirm valid claims
- identify skipped files or overlooked changes
- update final verdict

Actuarius should copy Magpie's fairness rule here: all reviewers in round 2 should see the same round 1 snapshot, and they should run in parallel.

### Stage 5: Convergence check

This can be simpler than Magpie in v1.

Instead of a separate convergence judge immediately, Actuarius can stop after round 1 when:

- all reviewers say `ready for PR`
- no blocking issues are present

Otherwise, run round 2 and then summarize.

### Stage 6: Summarizer

One neutral model synthesizes:

- consensus issues
- disputed issues
- required fixes before PR
- recommended PR description bullets
- final verdict: `revise` or `ready_for_pr`

That final verdict is the gating output for the future PR command.

## Prompting Guidance

Magpie gets good mileage from anti-sycophancy instructions. Actuarius should adopt that, but keep prompts output-structured.

Recommended reviewer contract:

- "You are in an adversarial review with other reviewers."
- "Do not agree unless the evidence supports it."
- "If another reviewer missed files or reasoning gaps, say so explicitly."
- "You must review all changed files, not only the most obvious ones."
- "Prefer concrete findings with file paths and rationale."

For Actuarius, require a machine-readable footer or JSON block per reviewer:

```json
{
  "verdict": "ready_for_pr",
  "blockingIssues": [],
  "nonBlockingIssues": [],
  "missingTests": [],
  "reviewedFiles": ["src/foo.ts", "src/bar.ts"]
}
```

This will make PR gating and later PR comment generation much easier than parsing free-form prose.

## What Not To Copy From Magpie

### Do not make this a separate generic CLI first

Actuarius already owns the user interaction model. A detached CLI would duplicate:

- auth/config management
- repo/worktree discovery
- execution and logging
- persistence

### Do not require streaming sessions in v1

Magpie invests heavily in session-aware provider behavior because its UX is interactive and terminal-centric. Actuarius can run the review in discrete steps and post checkpoints to Discord.

### Do not start with repository-wide review

The use case here is "review the completed code for this request branch before PR," not "audit the whole repository."

## Implementation Plan

### Phase 1: Minimal viable review gate

- Add `/review`
- Require execution inside a request thread with a tracked branch
- Compute branch diff vs `master`
- Run:
  - analyzer
  - 3 reviewers in parallel for one round
  - summarizer
- Persist final review result
- Post markdown summary in thread

This phase is enough to prove value.

### Phase 2: Debate round and stricter gating

- Add optional second round
- Add reviewer-agreement heuristics
- Add `review_runs` status transitions
- Add guild-level adversarial review config

### Phase 3: PR gating integration

- Add `/pr`
- Refuse PR creation if:
  - no successful review exists for the current branch head
  - last review verdict is `revise`
  - branch changed since review completed
- Use summarizer output to seed PR body

## Recommended Data and Type Additions

### New enums or status types

- `ReviewRunStatus = "queued" | "running" | "succeeded" | "failed"`
- `ReviewVerdict = "ready_for_pr" | "revise"`

### Result shape

```ts
interface AdversarialReviewResult {
  requestId: number;
  branchName: string;
  diffBase: string;
  diffStat: {
    files: number;
    additions: number;
    deletions: number;
  };
  analysis: string;
  rounds: Array<{
    round: number;
    reviews: Array<{
      reviewerId: string;
      provider: "claude" | "codex" | "gemini";
      verdict: "ready_for_pr" | "revise";
      rawText: string;
      parsed?: {
        blockingIssues: string[];
        nonBlockingIssues: string[];
        missingTests: string[];
        reviewedFiles: string[];
      };
    }>;
  }>;
  finalSummary: string;
  finalVerdict: "ready_for_pr" | "revise";
}
```

## Risks and Design Constraints

### 1. Token and runtime cost

Running 3 reviewers plus analyzer plus summarizer is expensive in both time and model usage. Mitigations:

- keep default rounds at `1` or `2`
- cap diff size for v1
- allow `quick` mode

### 2. CLI authentication variance

Actuarius already knows whether Codex or Gemini auth is present. Review configuration should validate enabled reviewers before queueing work, otherwise the review becomes partially degraded.

### 3. Discord output limits

Long review transcripts will overflow Discord quickly. Persist full raw output in SQLite and post:

- short progress updates during execution
- concise final summary in-thread
- optional attached markdown artifact later

### 4. Branch drift

If the user edits code after review, the verdict is stale. A review record must capture the reviewed `HEAD` commit SHA, and PR creation should require the branch SHA to match.

### 5. False precision from LLM parsing

Magpie parses issues from prose. Actuarius should reduce this risk by requiring structured reviewer output from the start rather than relying on later extraction.

## Concrete Recommendation

Implement an Actuarius-native `/review` command that operates on the existing request thread and request branch. Start with:

- analyzer
- 3 parallel reviewers
- optional second round only when blocking issues or disagreement exist
- neutral summarizer
- persisted structured result with final verdict

Do not build a standalone Magpie-like CLI first. Reuse Actuarius's existing Discord workflow, worktree tracking, provider runners, queue, and database. The future `/pr` command should be explicitly gated on the latest successful review result for the current branch SHA.

## Suggested File-Level Work Split

- command registration and Discord handler changes:
  - [src/discord/commands.ts](/data/repos/.worktrees/digitumdei/actuarius/70/src/discord/commands.ts)
  - [src/discord/bot.ts](/data/repos/.worktrees/digitumdei/actuarius/70/src/discord/bot.ts)
- git diff helpers:
  - [src/services/gitWorkspaceService.ts](/data/repos/.worktrees/digitumdei/actuarius/70/src/services/gitWorkspaceService.ts)
- review orchestration:
  - new `src/services/adversarialReviewService.ts`
- persistence and migrations:
  - [src/db/database.ts](/data/repos/.worktrees/digitumdei/actuarius/70/src/db/database.ts)
  - [src/db/types.ts](/data/repos/.worktrees/digitumdei/actuarius/70/src/db/types.ts)

## Initial Acceptance Criteria

- `/review` can be run from an implementation thread with a tracked branch.
- Review uses the request branch diff against `master`.
- At least 2 providers can review in parallel.
- Final output contains blocking issues, non-blocking issues, missing tests, and verdict.
- Review result is persisted with the reviewed branch SHA.
- A later PR flow can verify that the latest review matches the current branch SHA.
