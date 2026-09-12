# Automatic coordination task pickup

Status: implementation and design record, 2026-09-12, tracked by issue #219. The implementation is opt-in through `COORDINATION_ENABLED`; it has not been deployed or enabled by this change. The native correction/result lifecycle has been verified against an isolated AgentPalace process. See the operating notes below for the implemented interface and recovery behavior.

## Core model

AgentPalace owns durable coordination tasks, dependencies, leases, messages, and results. Actuarius owns execution policy, scheduling, provider processes, Git workspaces, and Discord presentation. A Discord command and automatic pickup should enter the same execution service.

Confirmed operating constraint: Actuarius struggles to run more than one LLM at a time. Multiple repositories and tasks are a durable queuing problem. There is one global LLM execution slot across automatic tasks, manual commands, planners, and reviewers. This design does not require parallel LLM execution.

Separate these identities:

| Entity | Lifetime and responsibility |
| --- | --- |
| Repository | Stable registered identity; remote, memory wing, branch policy, permissions, Discord channel |
| Task | Durable unit of work, identified by authority plus task ID |
| Workspace | Persistent branch/worktree for a larger piece of work in one repository, identified by `work_id` |
| Attempt | One execution of a task; provider, revision, lease, timings, outcome |
| Workflow | Parent task linking children, dependencies, and overall acceptance criteria |

Multiple coordination tasks contribute to the same larger piece of work by referencing its `work_id`. Implementation, review, and revision tasks reuse that work's branch/worktree, as do retries. An individual AgentPalace task ID identifies one coordination task; `work_id` identifies the shared workspace and is distinct from that task ID. Independent pieces of work use different work IDs, even in the same repository. A task without repository context need not allocate a Git workspace.

Each work ID maps to one repository workspace. A cross-repo effort uses a separate work ID per repository, grouped through AgentPalace's native parent task. Sharing a work ID specifies where tasks work; native dependencies specify their required order. Completing one contributing task neither closes the larger work item nor deletes its workspace.

## Repository and branch resolution

Register a mapping from coordination authority and wing to an Actuarius repository ID. Do not infer repository paths from task prose or assume a wing name uniquely identifies a repository. Ambiguous mappings need an explicit repository ID.

Each workspace records repository ID, branch name, path, starting ref, resolved starting commit, integration target, and memory view. Resolve the starting commit once at provisioning; a retry must not silently reset to a newer base.

Keep three concepts distinct:

- Canonical ref: the long-lived line of repository truth selected for context.
- Starting ref/commit: where this particular change begins; may be a dependency's output commit.
- Integration target: where its PR should merge, which may be develop or a maintenance branch.

The first accepted submission for a work ID must explicitly supply repository, base_ref, and integration_target. Validate them against repository policy; do not silently fill missing setup fields or guess master. Later tasks inherit the registered setup and cannot override it. Branch rules should follow AgentPalace's eventual shared policy; do not invent a competing policy format while its issue #75 remains open.

Use stable workspace-derived branch names, for example `actuarius/<workspace-id>-<slug>`, and paths under `.worktrees/<repo-id>/<workspace-id>`. Provision new branches without force-resetting existing refs. Resume only after verifying the saved repository, worktree, branch, and HEAD; unexpected changes require reconciliation.

Memory uses the repository's wing and the selected branch/worktree view. Separate task branches must not be blended into the canonical view. A worktree is an execution location, not a new project registration. Several worktrees may be retained while only one is actively executing; their purpose is to preserve isolated task state between turns in the queue.

## Eligibility and dispatch contract

Every repository connected to Actuarius through Discord is eligible for automatic coordination pickup. No separate per-repository opt-in or creator allowlist is required. Dion confirmed that only he can access the tunnel and Discord channel; configured AgentPalace sources and existing access controls define the trusted intake boundary. Tasks must target `executor: "actuarius"`, pass validation, and resolve to a currently connected repository. Recheck repository connection at execution; disconnected or unknown repositories require correction. Creator names are attribution/routing identifiers, not authentication. This policy applies when the dispatcher is implemented and enabled; recording it does not start execution today.

Required dispatch information: version, executor, action kind, workspace work_id for repository work, requirements, acceptance criteria, and an explicit deliverable: workspace_changes, report, or draft_pr. Unknown work IDs additionally require repository, base_ref, and integration_target inside workspace. Version 1 rejects unknown fields, including nested fields, to catch typos; schema extensions require a supported version. There is no new/continue mode or separate parent workspace declaration: registration determines whether setup is needed.

Proposed refinement following discussion: keep AgentPalace's coordination schema generic. Its current task-create surface has a description but no typed repository or executor field. Store an Actuarius-owned, versioned JSON block in the description, alongside human-readable context. AgentPalace stores it as task content; Actuarius owns its schema and validation. Do not overload the budget field with routing data.

First submission for a new work ID:

````markdown
```actuarius-task
{
  "version": 1,
  "executor": "actuarius",
  "action": "implement",
  "workspace": {
    "work_id": "coordination-rollout-7f93",
    "repository": "DigitumDei/Actuarius",
    "base_ref": "main",
    "integration_target": "main"
  },
  "requirements": ["Automatically queue eligible coordination tasks"],
  "acceptance_criteria": ["Only one LLM invocation runs at a time"],
  "deliverable": "workspace_changes"
}
```
````

Later tasks use the same block format, with only the work ID in workspace:

```json
{
  "version": 1,
  "executor": "actuarius",
  "action": "implement",
  "workspace": { "work_id": "coordination-rollout-7f93" },
  "requirements": ["Add correction feedback for invalid submissions"],
  "acceptance_criteria": ["Missing setup fields produce specific correction requests"],
  "deliverable": "workspace_changes"
}
```

Deliverables are required rather than inferred. `workspace_changes` contributes changes to the shared branch. `report` returns findings without implementing changes. `draft_pr` completes the applicable review/delivery steps and opens or updates the work's draft PR. Automatic merging and releasing are outside the first implementation. Waiting for externally performed merges or releases remains supported through dependency gates. Local paths and credentials never belong in this block. Native task dependencies and parent IDs remain the source of truth for task relationships; explicit delivery gates may refer to those dependencies without duplicating the graph.

### Work ID registration and reuse

- Unknown work ID: require repository, base_ref, and integration_target. Missing setup returns the submission for correction.
- Known work ID: reuse its registered repository, branch, and worktree. Setup fields can be omitted; any supplied fields must match the registration.
- Conflicting setup: return precise diagnostics rather than changing the existing workspace or resetting its branch.

Register the work ID and accepted setup atomically when validation succeeds, with a uniqueness constraint in the Actuarius instance's registry. Recheck inside the transaction: two matching first submissions converge on one registration, while conflicting submissions cannot overwrite each other. Use collision-resistant IDs and check submitter access on every reuse; knowing an ID is not authorization. Registration records the supplied refs; physical worktree creation and resolution of the starting commit happen once at first execution. A retry never recreates or resets an existing workspace.

A previously received but invalid submission does not register its work ID. If a reference-only task arrives before successful registration, it needs correction or revalidation after setup is accepted. Keep a record of closed work IDs so cleanup does not make an old ID appear new; resuming closed work requires an explicit lifecycle decision rather than silently creating another branch.

### Intake validation and requests for correction

Tasks targeting Actuarius from configured sources enter validation. An `actuarius-task` block also identifies an intended submission when its JSON is malformed or its executor field is missing; return diagnostics through coordination. Tasks explicitly targeting another executor, or ordinary tasks with no Actuarius marker, are left alone. Every Discord-connected repository is supported without an additional intake opt-in.

1. Code checks block count/size, JSON syntax, schema version, required fields, repository registration, workspace/ref validity, and allowed actions. Reject duplicate blocks and unsupported versions with precise diagnostics. These checks need no LLM.
2. A queued validation LLM checks meaning: whether the prose and block agree, requirements are actionable, acceptance criteria are adequate, and material ambiguity remains. It may propose corrections but cannot invent authorization, choose an ambiguous repository, or silently change task intent. Its verdict is schema-validated as ready or needs_input, with reasons and questions. Provider failure is a retryable validation failure, not evidence the task is invalid.
3. A ready verdict produces a persisted execution specification and atomically registers or verifies the work ID as above. Known work IDs supply their saved setup. Implementation joins the execution queue when dependencies are satisfied. Validation consumes the same global single-LLM slot as execution; it does not run alongside another task.
4. Missing or conflicting information produces a persisted correction report and, through the supervisor, an input_required transition and addressed feedback to the submitter. The task waits while other work proceeds. No implementation worktree is provisioned merely to inspect its JSON.

Bind validation to the exact task content, accepted clarification IDs, and schema/policy version. Recheck before execution and invalidate a verdict when those inputs change; lease-only revision changes do not require another LLM review. Persist fingerprints and idempotent feedback records to avoid repeatedly validating or returning the same unchanged submission.

Initial validation can be read-only before an execution claim. Any authoritative correction-state update must re-fetch and use compare-and-swap; if another worker owns the task or its content changed, do not overwrite it. Execution still requires the existing authoritative lease claim. Exact lifecycle transitions need an integration check before implementation.

The currently exposed tools do not provide a task-description edit operation. Corrections arrive as an addressed task message containing a complete replacement JSON block, from the original creator or an authorized operator. Feedback includes a validation-attempt identifier, which the correction must reference. The supervisor accepts only a correction for the current outstanding validation attempt; delayed replies cannot overwrite newer corrections. It persists the accepted effective specification and automatically requeues validation, preserving the task's original implementation queue position. This avoids assuming a nonexistent edit API or automatically creating a replacement task that breaks dependencies. Message ingestion and resume transitions must be verified against the coordination lifecycle before enabling this path.

Both the JSON checker and LLM validator use this same standard coordination feedback path. Code performs the state changes and sends the messages; the LLM supplies a validated verdict and explanation. Use task_transition with input_required and message_send addressed to the task's created_by identity. Consume corrections through inbox_read, associate them with the original task, durably accept authorized corrections, then acknowledge them. Exact message kind/payload conventions are Actuarius-owned and versioned. Resume through supported transitions after revalidation rather than inventing a new AgentPalace state. Task ID, dependencies, and work_id remain unchanged; a correction attempting to change an established workspace binding requires explicit handling, not silent reassignment.

### Escalation to human input through Discord

The submitting agent normally answers validation feedback through coordination. If the decision needs Dion, it can instead send an Actuarius-defined `human_input_required` coordination message on the same task. This is a message kind, not a new AgentPalace task state; the task remains input_required and releases the execution slot.

The versioned payload identifies the outstanding validation attempt and includes a specific question, why human input is needed, and optional choices/recommendation. Accept escalation from the submitting agent or operator only for the current outstanding question. Actuarius posts it in the work_id thread with task identity and a reply control tied to that question. If intake has not yet resolved a valid workspace/repository, use the configured coordination channel and retain the same task correlation; do not fabricate a workspace merely to ask a question.

Dion can answer in Discord without writing JSON. Persist his answer, then send it through a standard coordination message to the submitting agent, correlated to the task and question. That agent supplies the complete corrected JSON block; Actuarius revalidates through the normal path. A human answer alone does not bypass validation or automatically mark a task ready. If the agent is unavailable, the answer stays durable and the task remains visibly awaiting its correction; operator-supplied complete corrections remain supported.

Coordination is the primary correction path; Discord is an optional human escalation surface. Both share one durable outstanding-question record. Resolve duplicate or competing replies atomically, reject stale replies, and mark Discord questions resolved when a valid correction arrives through either path. Do not interpret unrelated thread chatter as an answer. Retrying Discord/message delivery must not duplicate questions, rerun implementation, or lose the answer. Waiting for the human or submitting agent never blocks other ready tasks and preserves the existing task's FIFO position.

## Pickup loop and recovery

1. Discover candidates from configured authorities/wings using task-list pages; persist independent cursors and candidate IDs.
2. Fetch candidate details and run intake validation as above, with semantic validation queued through the single LLM slot. Persist the accepted specification; implementation becomes eligible only after its dependency gates pass. Dependency count is not readiness, and claim does not enforce completed dependencies.
3. Select the oldest eligible Discord-priority entry, otherwise the oldest eligible background entry, across repos when the global LLM slot is free. Reserve that slot and the workspace lock before claiming; queued candidates remain unclaimed until dispatch. Do not lease a backlog while it waits.
4. Claim with the expected revision at the task's authority. Conflict is normal: refresh or skip. Persist the successful claim and attempt before launching a provider; validate the returned task again.
5. Resolve or resume the workspace, then execute through the shared request service. Maintain the lease from the supervisor independently of model output. Serialize renewals and transitions using the latest revision.
6. Persist results and artifacts with stable idempotency keys, then perform the authoritative task transition. Use a durable outbox for retrying result publication and Discord delivery without rerunning completed work.

Task-list cursors follow creation order, not updates. Periodically rescan from the beginning and revisit tracked blocked/running tasks; otherwise an older task that becomes ready or loses its lease can be missed forever. Change events may accelerate discovery but do not replace reconciliation. Back off per unreachable authority without stopping healthy ones.

Use at-least-once discovery with idempotent local mappings, not an exactly-once claim about execution. A crash between remote claim and local persistence requires startup reconciliation of tasks owned by this worker instance. Stable instance identity and a distinct attempt identity are both required.

If lease renewal cannot be confirmed before its safety margin, stop the provider process tree and prevent further publication. A lease is not a filesystem or GitHub write fence: external side effects already in flight must be reconciled. Initial automatic recovery should stay on one Actuarius host. Cross-host failover requires fencing or separate attempt branches plus controlled publication; an expired lease alone does not prove the old process stopped.

On restart, reconcile leases, attempts, surviving processes, workspaces, and pending publications before accepting new work. Preserve dirty worktrees and failed output. Never force-clean to make a retry succeed. Waiting for input releases execution capacity and excludes the task from pickup until it is explicitly resumed through supported lifecycle transitions.

## Multiple tasks and repositories

- Same repo, independent changes: separate branches/worktrees, executed one after another through the shared queue.
- Same larger change, implementation/follow-up/review/revision: reference the same work_id and serialize every mutating operation on its workspace, including Discord commands.
- Same repo, dependent tasks sharing a work ID: continue the same branch, using dependencies to establish order. Separate work IDs represent separate branches; default to waiting for the prerequisite change to merge into the selected starting line. Stacked branches require an explicit request and the predecessor's recorded commit. A completed task does not imply its PR merged, and waiting for a merge does not authorize Actuarius to perform it.
- Different repos: entries share the same queue and execute one at a time. A parent aggregates their results without holding an execution slot while waiting; any LLM-based parent synthesis also enters the queue.
- Cross-repo dependency: specify the artifact gate, such as a merged commit, published package version, or report. Git branches in separate repos do not create a shared transaction.

Example: a parent requests an AgentPalace API change and Actuarius support. Child A implements the API in AgentPalace. Child B implements the consumer in Actuarius, gated on the selected API contract/version. If testing requires a published release, B waits for that artifact rather than merely A's task completion. The parent finishes only when both delivery requirements and integration validation are met. If one child fails, retain the other's PR and mark the workflow blocked; do not pretend to roll back both repositories atomically.

For v1, keep a workflow's tasks at one coordination authority, across repository wings. Cross-authority dependency semantics need a separate explicit contract; do not assume existing dependency IDs are globally resolvable.

### Native dependencies and readiness

Dependencies are AgentPalace task IDs in the task's native dependencies array, outside the Actuarius JSON block. For example, a review task declares `dependencies: ["task-implement"]`, and an integration task can declare `dependencies: ["task-api", "task-client"]`. Actuarius requires all dependencies to be completed before implementation becomes eligible. It checks authoritative state; the task-list dependency count and lease claim do not enforce readiness.

A failed, cancelled, expired, missing, or input_required dependency does not satisfy the gate. Keep the dependent blocked and expose the reason rather than executing it or treating all terminal states as success. Reject dependency cycles or surface them as blocked with actionable diagnostics. Native parent_id groups tasks; it does not implicitly establish order or workspace membership. Artifact gates such as merged PR or published release are additional requirements, or can be represented by a dedicated delivery task whose completion guarantees that artifact.

## Scheduling, visibility, and cleanup

Persist one host-wide queue and enforce exactly one active LLM invocation. Every provider launch path, including manual commands and nested planners/reviewers, must pass through that gate. A multi-model review runs reviewers sequentially. Workflow orchestration must not hold the LLM slot while waiting to acquire it for a child invocation. Keep workspace ownership separate from the LLM slot so unfinished changes cannot be modified by an unrelated command between workflow steps.

Discord-provided work goes ahead of background coordination work. Maintain one durable queue with two priority classes: Discord and background. Select the oldest eligible Discord entry first; if none is eligible, select the oldest eligible background entry. Preserve FIFO within each class across all repos, so several Discord requests run in submission order rather than reversing each other. This supersedes the earlier undifferentiated FIFO policy. Never interrupt an active LLM invocation merely because Discord work arrives. Continuous Discord work can delay background tasks; that follows the explicit user priority preference.

A blocked entry is skipped without losing its class or sequence. New follow-ups and retries join the tail of their class; delayed retries have a next-eligible time and a bounded retry count. Validation and bounded continuation steps retain their originating task's priority class, not a lock on the next slot. Priority is assigned by the trusted Discord intake path and persisted by the supervisor, not accepted from task JSON or an agent's claimed sender name. An explicit operator reprioritization changes the next selection without interrupting the current invocation. Status and cancellation controls remain responsive without needing an LLM.

Agreed ordering: tasks without dependencies are eligible after validation; tasks with dependencies wait, then use their original FIFO position within their priority class among ready tasks. An existing blocked task retains its position when dependencies or required input are resolved. A newly created continuation or a new retry attempt receives a new position. Queue sequence is local and durable, not a comparison of clocks across authorities. Revalidation of a corrected existing task must not accidentally replace its original implementation queue position. Priority never bypasses dependencies or workspace ownership: a Discord task waiting on background work stays blocked while that prerequisite runs normally.

The scheduling unit is a bounded execution step, not an entire cross-repo workflow. Run the current invocation to completion or its configured timeout; do not time-slice or preempt it merely because another repo has queued work. When a step finishes, append any ready continuation to the queue. Input, CI, merge, release, and dependency waits retain task/workspace state but release the execution slot. Persist checkpoints between steps so queue rotation does not depend on a live provider session.

For example: repo A implementation runs, then waits for CI; repo B's queued task runs next. When A's CI finishes, its review step becomes eligible and joins the queue. Its original worktree is reused when that step reaches the front. Non-LLM polling and notification delivery may continue in the background within host resource limits.

Discord presents one thread per work_id in the repository's existing channel. All contributing coordination tasks and attempts report in that shared thread, identifying which task each update concerns. Store work/thread and task/work mappings durably; input, cancellation, retry, and status must resolve the intended task explicitly when several share a thread. Cross-repo parents report overall status in a configured coordination channel with links to each repository work thread. Display dependency waits, running attempts, required input, and delivery links. A successful provider exit is only an attempt outcome: task completion follows its specified acceptance and delivery requirement. Discord delivery failure retries notification, not implementation.

Clean up by workspace lifecycle, not attempt completion. Active tasks, unresolved input, local unpublished changes, and open delivery work pin the workspace. Retain failures for inspection. Delete only under an explicit retention policy after verifying no references or valuable local changes remain.

### Unified Discord task intake

Discord and AgentPalace are submission paths into the same durable task/workspace/attempt model, validation flow, and global LLM queue. Discord submissions also create native coordination tasks so dependencies, results, and recovery have one lifecycle. Persist the Discord event-to-task mapping and use its stable interaction/message ID as the create idempotency key; redelivery or restart must not create a second task. If coordination is unavailable, retain the submission durably and report pending registration rather than start an untracked provider invocation.

| Discord input | Task/workspace behavior |
| --- | --- |
| `/ask` or `/plan` in a connected repo channel | Create a new work_id, its work thread, and an initial task |
| `/ask` or `/plan` inside an existing work thread | Create a task on that thread's work_id and existing branch |
| Ordinary user text in a work thread | Create a follow-up task on the existing work_id, preserving the current conversational behavior |
| Reply/answer control for a specific outstanding question | Answer that question on its existing task, without creating a new follow-up |
| `/review`, `/revise`, `/pr` in a work thread | Queue the corresponding operation against its workspace, retaining existing command checks and review/PR gates |
| `/tasks`, status, cancellation | Handle immediately without an LLM invocation |

Users do not write execution JSON in Discord. The adapter creates it from the command and known repo/workspace context. For a new work_id, it explicitly supplies repository, base_ref, and integration_target using verified repository configuration/ref resolution; unknown or ambiguous setup requires clarification. This does not relax the required setup fields for an unknown work_id. Any LLM-assisted interpretation of prose, requirements, or acceptance criteria consumes the single slot, at Discord priority. Do not silently invent user intent. Existing command semantics determine the requested action/deliverable; do not turn an ordinary question into a PR request.

Follow-ups are queued, not injected into a currently running invocation. A continuation records its predecessor task ID as a native dependency, including when that predecessor is still running or awaiting input. Use an explicit replied-to task when available; otherwise use the thread's latest applicable task. When multiple task contexts make that ambiguous, ask which is intended rather than silently choosing. Independent work sharing a workspace need not depend on its previous task, but its independence must be explicit. A repair request for failed work is a recovery action with preserved context, not an impossible completed-dependency on a failed task; the adapter must distinguish retry/repair from a normal success-dependent continuation.

Recognize answers through a question-correlated reply/control, not arbitrary thread text; ignore bot/system messages as submissions. Capture attachments and source message context as with existing Discord requests. Keep all replies correlated when several tasks share a thread. For Discord-originated clarification, Actuarius can incorporate the user's answer into the effective specification through queued validation; no external submitting agent is required. For externally submitted work escalated to Discord, return the human answer to its submitting agent as described above. Answering an external task's clarification does not automatically change that task's background priority; an explicit Discord resume/retry/work request can promote it without duplicating its identity.

Migrate existing work threads to work_id registrations pointing to their verified current branches/worktrees. Preserve their history and group requests sharing a worktree under one registration. Do not reset branches or allocate a new worktree merely to adopt the new model.

### Discord /tasks command

Add `/tasks` to list current Actuarius work without invoking an LLM or consuming the execution slot. Default to all connected repositories in the guild, regardless of the channel where invoked, so the shared queue is visible. Proposed optional filters: repository, work_id, and status. Default results include all unfinished tasks; an explicit history/status filter can expose recent completed, failed, or cancelled tasks.

Show the active execution first, then ready entries in actual dispatch order (Discord priority before background, FIFO within each), then blocked tasks with their retained class/queue sequence and blocking reason. A blocked entry's sequence is not its current runnable position. Show the current phase (validation, implementation, review, etc.) so a validation invocation occupying the single LLM slot is visible. Include manual Discord work sharing the same execution slot and identify its origin/priority; do not imply the worker is idle while a manual request runs.

Each row includes a concise title, task ID, repository, work_id when assigned, state/phase, ready queue position or wait reason, and a link to the work thread if created. Distinguish dependency waits, CI/merge/release waits, awaiting submitting-agent correction, and awaiting human input. For dependencies include the blocking task IDs; for human input link to the outstanding question. Unresolved intake tasks must still appear even before a workspace/thread exists.

Use the supervisor's durable queue and task mappings as the execution read model, reconciled with authoritative coordination state. Display last refresh/staleness or a source-unavailable notice when reconciliation fails; do not present unavailable remote tasks as an empty queue. Support bounded pagination and a refresh control with an explicit snapshot time, plus a clear empty-state response. Filtering never changes queue order or task state, and queue positions are snapshots rather than promised start times.

Acceptance coverage: multiple repos, manual and automatic entries, Discord priority reflected in runnable positions, blocked older tasks skipped in runnable positions, current validator phase, unresolved workspace, human question link, empty queue, pagination/filtering, and unavailable coordination source. The command remains responsive while the single LLM slot is occupied.

Discord intake acceptance cases: channel commands create work; thread commands/text reuse it; duplicate events create one task; a running invocation is not interrupted; ready Discord entries overtake background entries but remain FIFO among themselves; blocked Discord tasks do not stall background prerequisites; validation/review launches obey the one-slot limit; correlated answers do not create extra tasks or promote external work implicitly; disconnected coordination retains pending registration; failed-task repair does not deadlock on a completed-dependency; migration preserves existing worktrees and history.

## Fit with current code and implementation order

The existing `RequestExecutionQueue` has bounded guild concurrency and resource keys. `requestWorktreeService` currently creates request-derived branches from local master. Follow-ups already reuse a saved worktree, while requests carry branch/path fields. The durable workspace model formalizes that existing reuse.

1. Extract an execution service from Discord orchestration; add durable workspace and attempt mappings while preserving current command behavior. Migration must group existing requests by their verified shared worktree rather than create duplicate workspace owners.
2. Add the validated dispatch contract, eligibility based on Discord-connected repositories, and an observation-only discovery mode that explains eligibility without claiming.
3. Enable pickup into one durable queue across connected repositories, enforce the global single-LLM gate on every execution path, and add leases, recovery, and idempotent result delivery. Integrate startup/stuck-request handling so it cannot race the supervisor. Validate initially with one repo, then two repos sharing the same queue.
4. Add parent workflows and explicit cross-repo artifact gates. Multiple independent repos need no parent workflow and are supported by step 3. Defer cross-host execution and cross-authority dependencies.

Key acceptance cases: unknown work ID requires all setup fields; first valid submission registers once; subsequent tasks reuse the same branch; matching registrations converge and conflicting ones return diagnostics; invalid submissions do not reserve IDs; closed IDs cannot silently create fresh workspaces; contributing task completion retains the shared workspace; automatic and manual requests plus nested reviewers never overlap LLM processes; FIFO spans two repos; a blocked head entry does not stall ready work; CI/input waits free the slot; retry resumes the original workspace; restart preserves queue order; two workers race one claim; manual and automatic work target one workspace; old task becomes ready after a cursor advances; lease is lost mid-run; crash occurs after claim or result publication; dirty workspace survives restart; one repo is unavailable; task result exists but Discord delivery failed; dependency task completes before its required release exists.

## References and settled decisions

- Actuarius #2: https://github.com/DigitumDei/Actuarius/issues/2
- AgentPalace branch inference #74 (closed): https://github.com/DigitumDei/agentpalace/issues/74
- AgentPalace canonical refs/integration policy #75 (open): https://github.com/DigitumDei/agentpalace/issues/75
- AgentPalace task discovery #140 (closed): https://github.com/DigitumDei/agentpalace/issues/140

Decisions confirmed by Dion on 2026-09-12:

- Keep the version 1 Actuarius JSON block in generic task descriptions; require requirements, acceptance criteria, and deliverable, and reject unknown fields.
- Accept complete replacement blocks from the creator or operator via standard coordination messages, correlated to the outstanding validation attempt. Automatically revalidate and preserve the existing task's queue position.
- Support every repository added to Actuarius through Discord. Use configured AgentPalace sources and explicit executor targeting; no additional repository opt-in or creator allowlist. The tunnel and Discord channel are restricted to Dion.
- Require workspace_changes, report, or draft_pr as the deliverable. Automatic merge and release are outside v1.
- Reuse the same branch for a shared work_id. Default to merge-first dependencies between separate branches; stacking requires an explicit request.
- Use one Discord thread per work_id in the repository channel and a configured coordination channel for cross-repo parent summaries.
- Unify Discord commands and thread follow-ups with the coordination task/workspace model. Give Discord-provided work priority ahead of background tasks, FIFO within each class, without preempting active work or bypassing dependencies.

These settle the listed product choices. The actual coordination channel must be configured when enabling the feature. This does not authorize merging, releasing, or deploying it.

## Implemented interface and operations

The dispatcher, SQLite queue/work registry, AgentPalace adapter, and Git provisioning live in `src/services/coordination/`. `src/discord/coordinationBridge.ts` adapts Discord input and execution services. `providerGate.ts` serializes provider launches process-wide, including legacy paths. Reviewers run sequentially. Keep one bot process on the host: the provider gate is process-local, not a distributed semaphore.

Enable with `COORDINATION_ENABLED=true`, `MEMPALACE_ENABLED=true`, and `COORDINATION_CHANNEL_ID`. Both the database and repository volume must persist. Startup requires a ready AgentPalace connection; subsequent outages retain queued registrations and saved status. Polling runs every five seconds. Each configured source maintains its own discovery cursor; completed scans restart so older tasks changing state are reconsidered. Exact task/message operations use AgentPalace's authority routing. Keep dependencies for one workflow at one authority in v1.

Supported actions are `ask`, `implement`, `plan`, `plan-oc`, `review`, `revise`, `pr`, `report`, and `workflow`. A workflow has no workspace and delivers a report. `pr` requires `draft_pr`. Plans with report delivery stop after planning; other plans implement, verify, and persist each continuation. `iterative:false` selects a single implementation step followed by acceptance verification. `/plan-oc` uses the managed OpenCode model choices with supervisor-controlled sequential stages. It does not launch the previous native delegation session. Plain implementation also gets a separate acceptance-verification step. Draft PR delivery uses the configured adversarial review; `/pr` requires a completed review of the unchanged branch.

The schema rejects unknown fields. Work IDs are 1–128 alphanumeric, dot, underscore, or hyphen characters, starting with an alphanumeric character. Requirements and acceptance criteria contain 1–100 nonempty strings, each at most 16,000 characters; the whole description is limited to 128 KiB. Refs are bounded and reject revision-expression syntax. Gate entries are `{task_id, kind, ref?}` with `kind` one of `merged`, `release`, or `stacked`; `ref` is required for a release and names its tag. Each gate must reference a native dependency. Release gates require a published release containing the dependency's recorded output commit (or its matching squash merge), rather than merely a completed task.

The supervisor uses a persisted worker identity, revision-checked claims, 120-second leases renewed every 30 seconds, and aborts on lease loss. Native AgentPalace has no running-to-pending transition, so a queued continuation yields through `input_required` to `pending`, with scheduling details distinguishing it from a real question. A workspace remains owned by an unfinished execution across continuation steps; other workspaces can use the LLM slot meanwhile. A failed readiness check does not stall unrelated repositories.

Validation sends `validation_required` to the native task creator, with `{version:1, validation_id, questions, instructions}`. The creator replies to that message's sender using `task_correction` and `{version:1, validation_id, spec:<complete replacement JSON>}`. Invalid or stale corrections receive `correction_rejected`. To ask the operator, send `human_input_required` with `{version:1, validation_id, question, reason, choices?}`. A Discord reply generates `human_input_answer` with the same correlation and answer text; the submitting agent then supplies corrected JSON. The adapter acknowledges processed messages and persists outbound delivery keys. These are standard AgentPalace message kinds, not new AgentPalace task states.

Discord commands construct the same JSON and create native tasks with event-based idempotency. `/issue`, `/bug`, and `/issues mode:summary` are report tasks at Discord priority; issue creation retains its explicit GitHub operation. Ordinary messages in a work thread become follow-ups, including while a predecessor runs. Replies to task updates identify the intended predecessor; when several unfinished contexts exist, an uncorrelated message requests clarification. Replies to questions remain answers, including stale replies, and do not create duplicate tasks. Existing work threads are adopted from their saved request workspace.

`/tasks` shows four entries per page, global queue position, current step, dependency/ownership waits, work/thread links, input links, and snapshot freshness. Filters accept repository, work ID, phase/state, and page. Refresh reads saved state without launching a provider. `/cancel task_id:<ID>` also accepts the temporary Discord ID while native registration is pending. A cancellation during an uncertain registration is retained until the native create outcome is known.

On an interrupted invocation, retain files and require inspection plus an explicit correction or `/revise`. Operator revision resumes a waiting task under the same native ID and moves its new attempt to Discord priority, so successful dependents can eventually unblock. Corrected specs discard the previous execution checkpoint and revalidate against the retained worktree. Completed provider output is saved before result publication; publication and notification failures retry delivery without running the implementation again. A crash before that output checkpoint requires inspection because external side effects may already have happened.

Generic cleanup skips open registered workspaces. Explicit `/delete` refuses unresolved tasks, dirty files, and commits not integrated into the target; a successfully closed work ID cannot silently allocate a fresh branch. Squash-merged workspaces may require manual inspection before deletion because the deletion check conservatively uses commit ancestry. No automatic retention deletion, merge, release, or cross-host execution is enabled.

Verification includes scheduler priority and FIFO, dependency isolation, workspace ownership across continuations, corrected questions, lease-loss abort, failed publication/delivery, event deduplication, a real Git worktree surviving restart with dirty files, and a native AgentPalace protocol integration test. Run the latter with `AGENTPALACE_TEST_BINARY` pointing at the installed executable; it creates a temporary palace with stub embeddings and does not touch production tasks. A live Discord/provider end-to-end smoke test remains an activation check because this implementation has not been deployed.

## Recovery and execution safeguards

Validation and workflow summaries run in an isolated Git directory so providers that require a Git working directory can execute. A requested `input_required` transition remains durable and retryable until AgentPalace confirms it; polling preserves Discord answers received while a request is in flight. Individual discovery lookup failures are retried without blocking later pages.

Discord follow-ups inherit their predecessor's coordination wing. Discovery records the owning authority, and registration selects a configured write route to that authority. If no route exists, registration waits with an actionable error instead of creating the dependency at another authority.

A merged dependency must also be present in the retained consumer branch (or its frozen base). If it is missing, integrate it into that branch before continuing. Workflow parents can evaluate merged and release gates using their dependencies' repositories without owning a worktree.

Attachments are isolated by task ID even when tasks share a workspace request ID. Discord thread names include a stable hash of the complete work ID to distinguish long IDs with the same prefix.

Coordination `/cancel` requires the task's Discord requester or `Manage Server`; `/review`, `/revise`, and `/pr` require the workspace's original requester or `Manage Server`. Background tasks require a server manager for these operator commands. Integration targets must identify an existing remote branch; commit SHAs remain supported as base refs.

Scheduling resumes through `pending` if a crash or transport failure leaves a validated task in native `input_required`. Iterative verification retains the baseline from the first implementation attempt until that plan task is approved. The legacy request row reflects the shared workspace's queued/running and final state across all execution paths; cancellation and interrupted work map to its existing `failed` status, with detailed state retained in `/tasks`.
