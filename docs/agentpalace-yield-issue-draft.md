# Upstream issue: task yield with executor affinity

Published as [AgentPalace #153](https://github.com/DigitumDei/agentpalace/issues/153).

Actuarius needs to release a task lease between sequential execution stages while preserving routing to the executor that holds its checkpoint. The current lifecycle has no running-to-pending yield edge, so it uses running → input_required → pending.

That workaround exposes a false human-input state to watchers and briefly makes the task unowned and claimable by another worker. Its checkpoint remains in the original Actuarius instance's durable SQLite database, so a different worker cannot safely continue it.

Please add an optimistic-revision-checked yield/release transition with executor affinity, or a resumable state that preserves the assigned executor. It should release the active lease, distinguish scheduling waits from human input, expose the reason in events, and allow the assigned executor to reclaim idempotently after restart. Specify lease expiry and cancellation behavior, including how another executor can take over only with an explicit checkpoint handoff.

Acceptance coverage: yield between stages without input_required events; competing workers cannot claim an affine continuation; the original worker reclaims after restart; repeated yields are safe under lost responses/revision conflicts; cancellation remains available while yielded.

Origin: https://github.com/DigitumDei/Actuarius/pull/220#discussion_r3997137671
