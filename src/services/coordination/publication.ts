import { z } from "zod";
import type { CoordinationStore, Entry, Work } from "./store.js";
import { fingerprint } from "./contract.js";
import { git, resolveRef } from "./workspace.js";
import { getHeadSha, hasUncommittedChangesExcluding, pushBranch } from "../gitWorkspaceService.js";
import { createDraftPullRequest, updateDraftPullRequest } from "../pullRequestService.js";
import { getGitHubCommandEnvironment } from "../githubAuthService.js";
import { spawnCollect } from "../../utils/spawnCollect.js";

export interface CiCheck { name: string; state: string; url: string }
export interface CiEvidence {
    sha: string;
    state: "pending" | "passed" | "failed" | "unavailable";
    checks: CiCheck[];
    detail: string;
    observedAt: string;
}
export interface DraftPublication {
    entryId: string;
    specHash: string;
    sha: string;
    url: string | null;
    ci: CiEvidence | null;
    review: "pending" | "ready" | "revise";
    reviewSha?: string;
    handedOff?: boolean;
    mergedSha?: string;
    taskSha?: string;
    mergeState?: "integrating" | "integrated";
    integratedHead?: string;
}
export interface PublishedPr {
    number: number;
    url: string;
    state: string;
    isDraft: boolean;
    headRefName: string;
    headRefOid: string;
    baseRefName: string;
    mergeCommit: { oid: string } | null;
}
const prSchema = z.object({ number: z.number(), url: z.string(), state: z.string(), isDraft: z.boolean(),
    headRefName: z.string(), headRefOid: z.string(), baseRefName: z.string(), mergeCommit: z.object({oid:z.string()}).nullable() });
async function gh(work: Work, args: string[], signal?: AbortSignal): Promise<string> {
    const result = await spawnCollect("gh", args, { cwd: work.path!, env: getGitHubCommandEnvironment(), timeoutMs: 60000, maxBuffer: 4 * 1024 * 1024, ...(signal ? {signal} : {}) });
    return result.stdout;
}
export async function readPublishedPr(work: Work, url: string, signal?: AbortSignal): Promise<PublishedPr> {
    return prSchema.parse(JSON.parse(await gh(work, ["pr", "view", url, "--repo", work.repository, "--json", "number,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeCommit"], signal)));
}
function target(work: Work): string { return work.integration_target.replace(/^origin\//u, ""); }
function gitCommand(work: Work, args: string[], signal?: AbortSignal): Promise<string> {
    return signal ? git(work.path!,args,signal) : git(work.path!,args);
}

/** Recover pre-publication-metadata tasks only through their retained owner, SHA and exact branch/base. */
export async function findLegacyPublication(store: CoordinationStore, entry: Entry, work: Work, signal?: AbortSignal): Promise<DraftPublication | null> {
    const taskSha = store.meta(`output-sha:${entry.id}`);
    if (work.publication || entry.spec?.deliverable !== "draft_pr" || !taskSha || store.meta(`workspace-owner:${work.work_id}`) !== entry.id) return null;
    const prs = z.array(prSchema).parse(JSON.parse(await gh(work,["pr","list","--repo",work.repository,"--state","all","--head",work.branch,"--base",target(work),"--limit","20","--json","number,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeCommit"], signal)));
    const pr = prs.find(p=>p.headRefName===work.branch && p.baseRefName===target(work) && ["OPEN","MERGED"].includes(p.state));
    if (!pr) return null;
    return {entryId:entry.id,specHash:fingerprint(entry.spec),sha:pr.headRefOid,taskSha,url:pr.url,ci:null,review:"pending"};
}

/** Normal pushes only. Draft publication never confers review approval. */
export async function publishDraft(store: CoordinationStore, entry: Entry, work: Work, report: string, signal: AbortSignal): Promise<DraftPublication> {
    if (entry.spec?.deliverable !== "draft_pr") throw new Error("Draft publication is not authorized for this task");
    signal.throwIfAborted();
    if (await hasUncommittedChangesExcluding(work.path!, ["docs/reviews/"])) throw new Error("Commit the checkpoint before publishing a draft");
    const sha = await getHeadSha(work.path!);
    const changes = await gitCommand(work, ["diff", `origin/${target(work)}...${sha}`, "--", ".", ":(exclude)docs/reviews/**"], signal);
    if (!changes.trim()) throw new Error("No meaningful implementation checkpoint to publish");
    const recovered = await findLegacyPublication(store,entry,work,signal);
    if (recovered) {work.publication=recovered;store.saveWork(work);}
    const prior = work.publication;
    if (prior?.url) {
        const pr = await readPublishedPr(work, prior.url, signal);
        if (pr.headRefName !== work.branch || pr.baseRefName !== target(work)) throw new Error("Published PR does not match the registered branch and integration target");
        if (pr.state === "MERGED") throw new Error("The previous draft is merged; reconcile it before publishing more work");
        if (pr.state !== "OPEN" || !pr.isDraft) throw new Error("Publication requires an open draft; external PR state needs operator reconciliation");
        if (pr.headRefOid !== sha) {
            await gitCommand(work, ["fetch", "origin", `refs/pull/${pr.number}/head`], signal);
            if (await gitCommand(work, ["rev-parse", "FETCH_HEAD"], signal) !== pr.headRefOid) throw new Error("Remote PR changed during publication reconciliation");
            await gitCommand(work, ["merge-base", "--is-ancestor", pr.headRefOid, sha], signal);
        }
    }
    if (await getHeadSha(work.path!) !== sha) throw new Error("Branch changed while preparing draft publication");
    signal.throwIfAborted();
    if (prior?.sha !== sha) await pushBranch(work.path!, work.branch, signal);
    signal.throwIfAborted();
    const publication: DraftPublication = {
        entryId: entry.id, specHash: fingerprint(entry.spec), sha, url: prior?.url ?? null,
        ci: prior?.ci?.sha === sha ? prior.ci : null,
        review: "pending"
    };
    work.publication = publication;
    store.saveWork(work);
    const body = `Work: ${work.work_id}\nTask: ${entry.task?.task_id ?? entry.id}\nPublished checkpoint: ${sha}\nReview: pending; this draft is not approved for merge.\n\nRequirements:\n${entry.spec.requirements.join("\n")}\n\nAcceptance criteria:\n${entry.spec.acceptance_criteria.join("\n")}\n\n${report}`;
    publication.url ??= await createDraftPullRequest({ worktreePath: work.path!, head: work.branch, base: target(work), title: entry.spec.requirements[0]!.slice(0,120), body, signal });
    signal.throwIfAborted();
    store.saveWork(work);
    await updateDraftPullRequest(work.path!, publication.url, body, signal);
    return publication;
}

/** Collect every reported check/status for this exact commit, including paginated results. */
export async function readCi(work: Work, sha: string, signal?: AbortSignal): Promise<CiEvidence> {
    const evidence: CiEvidence = { sha, state: "unavailable", checks: [], detail: "", observedAt: new Date().toISOString() };
    try {
        const checkPages = z.array(z.object({ check_runs: z.array(z.object({
            id:z.number(), app:z.object({id:z.number()}).nullable(), name:z.string(), head_sha:z.string(), status:z.string(), conclusion:z.string().nullable(), details_url:z.string().nullable()
        })) })).parse(JSON.parse(await gh(work, ["api", `repos/${work.repository}/commits/${sha}/check-runs?per_page=100`, "--paginate", "--slurp"], signal)));
        const statusPages = z.array(z.object({ sha:z.string(), statuses:z.array(z.object({context:z.string(),state:z.string(),target_url:z.string().nullable()})) }))
            .parse(JSON.parse(await gh(work, ["api", `repos/${work.repository}/commits/${sha}/status?per_page=100`, "--paginate", "--slurp"], signal)));
        const checks = checkPages.flatMap(p => p.check_runs);
        if (checks.some(c => c.head_sha !== sha) || statusPages.some(p => p.sha !== sha)) throw new Error("GitHub returned CI for a different commit");
        const latest = new Map<string, typeof checks[number]>();
        for (const check of checks) {
            const key=`${check.app?.id ?? "unknown"}:${check.name}`;
            if (!latest.has(key) || latest.get(key)!.id < check.id) latest.set(key,check);
        }
        evidence.checks = [...latest.values()].map(c => ({ name:c.name, state:c.status !== "completed" ? "pending" : c.conclusion ?? "unknown", url:c.details_url ?? "" }));
        const contexts = new Set<string>();
        for (const status of statusPages.flatMap(p => p.statuses)) {
            if (contexts.has(status.context)) continue;
            contexts.add(status.context);
            evidence.checks.push({name:status.context,state:status.state,url:status.target_url ?? ""});
        }
        const states = evidence.checks.map(c => c.state);
        if (states.some(s => ["cancelled","timed_out","stale","action_required","startup_failure","error","unknown"].includes(s))) evidence.state="unavailable";
        else if (states.includes("failure")) evidence.state="failed";
        else if (!states.length || states.includes("pending")) evidence.state="pending";
        else if (states.every(s => ["success","neutral","skipped"].includes(s)) && states.includes("success")) evidence.state="passed";
        evidence.detail=evidence.checks.map(c=>`${c.name}: ${c.state}${c.url ? ` (${c.url})` : ""}`).join("\n") || "No checks have been reported for this commit yet";
        if (evidence.state === "failed") {
            const runs=new Set(evidence.checks.filter(c=>c.state==="failure").map(c=>c.url.match(/\/actions\/runs\/(\d+)/u)?.[1]).filter((id):id is string=>Boolean(id)));
            for (const run of runs) {
                try { evidence.detail += `\n\nFailed jobs in run ${run}:\n${(await gh(work,["run","view",run,"--repo",work.repository,"--log-failed"],signal)).slice(-40000)}`; }
                catch (error) { if (signal?.aborted) throw error; evidence.detail += `\nFailure logs unavailable for ${run}: ${error instanceof Error ? error.message : String(error)}`; }
            }
        }
    } catch (error) { if (signal?.aborted) throw error; evidence.detail = `CI unavailable: ${error instanceof Error ? error.message : String(error)}`; }
    return evidence;
}

/** Follow an external draft update only when the retained local head can fast-forward. */
export async function refreshDraftHead(work: Work, signal: AbortSignal): Promise<void> {
    if (!work.publication?.url) return;
    const pr = await readPublishedPr(work,work.publication.url,signal);
    if (pr.state !== "OPEN" || !pr.isDraft || pr.headRefName !== work.branch || pr.baseRefName !== target(work))
        throw new Error("External PR state changed; reconcile the task before continuing publication");
    const local = await getHeadSha(work.path!);
    if (pr.headRefOid === local || pr.headRefOid === work.publication.sha) return;
    if (await hasUncommittedChangesExcluding(work.path!,["docs/reviews/"])) throw new Error("Inspect dirty retained work before integrating an external draft update");
    await gitCommand(work,["fetch","origin",`refs/pull/${pr.number}/head`],signal);
    if (await gitCommand(work,["rev-parse","FETCH_HEAD"],signal) !== pr.headRefOid) throw new Error("External draft changed while refreshing its head");
    // A local continuation ahead of the remote is publishable; never reset it.
    try { await gitCommand(work,["merge-base","--is-ancestor",pr.headRefOid,local],signal); return; }
    catch { /* test the opposite direction before integrating */ }
    await gitCommand(work,["merge-base","--is-ancestor",local,pr.headRefOid],signal);
    signal.throwIfAborted();
    await gitCommand(work,["merge","--ff-only",pr.headRefOid],signal);
}

/** Preserve external commits and integrate a confirmed merge without resetting a retained branch. */
export async function reconcileMergedDraft(store: CoordinationStore, entry: Entry, work: Work, signal?: AbortSignal): Promise<string | null> {
    const recovered = await findLegacyPublication(store,entry,work,signal);
    if (recovered) {work.publication=recovered;store.saveWork(work);}
    const publication = work.publication;
    if (!publication?.url || publication.entryId !== entry.id || publication.specHash !== fingerprint(entry.spec)) return null;
    const pr = await readPublishedPr(work, publication.url, signal);
    if (pr.state !== "MERGED") return null;
    if (pr.headRefName !== work.branch || pr.baseRefName !== target(work) || !pr.mergeCommit) throw new Error("Merged PR does not match this task's registered workspace");
    signal?.throwIfAborted();
    if (await hasUncommittedChangesExcluding(work.path!, ["docs/reviews/"])) throw new Error("Retained worktree is dirty; inspect before reconciling the external merge");
    await gitCommand(work, ["fetch", "origin", `refs/pull/${pr.number}/head`], signal);
    if (await gitCommand(work, ["rev-parse", "FETCH_HEAD"], signal) !== pr.headRefOid) throw new Error("External PR head could not be confirmed");
    await gitCommand(work, ["merge-base", "--is-ancestor", publication.taskSha ?? publication.sha, pr.headRefOid], signal);
    const local = await getHeadSha(work.path!);
    const integrating = Boolean(publication.mergeState && publication.mergedSha === pr.mergeCommit.oid);
    if (publication.mergeState === "integrated" && publication.integratedHead && local !== publication.integratedHead)
        throw new Error("Retained branch changed after merge integration; inspect before completing the task");
    if (integrating) {
        await gitCommand(work, ["merge-base", "--is-ancestor", pr.headRefOid, local], signal);
    } else {
        await gitCommand(work, ["merge-base", "--is-ancestor", local, pr.headRefOid], signal);
    }
    await gitCommand(work, ["fetch", "origin"], signal);
    await gitCommand(work, ["merge-base", "--is-ancestor", pr.mergeCommit.oid, await resolveRef(work.path!, work.integration_target, signal)], signal);
    signal?.throwIfAborted();
    if (!integrating) await gitCommand(work, ["merge", "--ff-only", pr.headRefOid], signal);
    publication.mergedSha=pr.mergeCommit.oid;publication.mergeState="integrating";store.saveWork(work);
    try { await gitCommand(work, ["merge", "--no-edit", `origin/${target(work)}`], signal); }
    catch (error) {
        try { await gitCommand(work, ["merge", "--abort"]); }
        catch { /* a cancelled or failed merge may not have created MERGE_HEAD */ }
        throw error;
    }
    signal?.throwIfAborted();
    publication.integratedHead=await getHeadSha(work.path!);
    publication.mergeState="integrated";
    store.saveWork(work);
    store.setMeta(`output-sha:${entry.id}`,pr.mergeCommit.oid);
    return `${pr.url}\nExternally merged as ${pr.mergeCommit.oid}. Retained workspace includes the external head and current ${target(work)}. Local review status was ${publication.review}; external merge is the completion evidence.`;
}
