import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinationStore } from "../src/services/coordination/store.js";
import { executionSchema, fingerprint } from "../src/services/coordination/contract.js";
import { findLegacyPublication, publishDraft, readCi, reconcileMergedDraft, refreshDraftHead } from "../src/services/coordination/publication.js";
import { git, resolveRef } from "../src/services/coordination/workspace.js";
import { getHeadSha, hasUncommittedChangesExcluding, pushBranch } from "../src/services/gitWorkspaceService.js";
import { createDraftPullRequest, updateDraftPullRequest } from "../src/services/pullRequestService.js";
import { spawnCollect } from "../src/utils/spawnCollect.js";
vi.mock("../src/services/coordination/workspace.js",()=>({git:vi.fn(),resolveRef:vi.fn()}));
vi.mock("../src/services/gitWorkspaceService.js",()=>({getHeadSha:vi.fn(),hasUncommittedChangesExcluding:vi.fn(),pushBranch:vi.fn()}));
vi.mock("../src/services/pullRequestService.js",()=>({createDraftPullRequest:vi.fn(),updateDraftPullRequest:vi.fn()}));
vi.mock("../src/utils/spawnCollect.js",()=>({spawnCollect:vi.fn()}));
vi.mock("../src/services/githubAuthService.js",()=>({getGitHubCommandEnvironment:()=>({})}));
const stores:CoordinationStore[]=[];
const url="https://github.com/owner/repo/pull/12";
const pr={number:12,url,state:"OPEN",isDraft:true,headRefName:"actuarius/work",headRefOid:"sha",baseRefName:"main",mergeCommit:null};
beforeEach(()=>{
    vi.resetAllMocks();vi.mocked(git).mockResolvedValue("meaningful diff");vi.mocked(resolveRef).mockResolvedValue("main-sha");
    vi.mocked(getHeadSha).mockResolvedValue("sha");vi.mocked(hasUncommittedChangesExcluding).mockResolvedValue(false);
    vi.mocked(createDraftPullRequest).mockResolvedValue(url);vi.mocked(spawnCollect).mockResolvedValue({stdout:JSON.stringify(pr),stderr:""});
});
afterEach(()=>{for(const store of stores.splice(0))store.close();});
function fixture(){
    const store=new CoordinationStore(":memory:");stores.push(store);
    const spec=executionSchema.parse({version:1,executor:"actuarius",action:"implement",workspace:{work_id:"work",repository:"owner/repo",base_ref:"main",integration_target:"main"},requirements:["Foundation only; OAuth deferred"],acceptance_criteria:["Foundation contracts pass CI"],deliverable:"draft_pr"});
    const entry=store.add({id:"task",source:"background",sender:"sender",wing:"wing_repo",description:"",spec,work_id:"work"});
    const work=store.register(spec.workspace!);work.path="/work";work.branch=pr.headRefName;store.saveWork(work);
    return {store,entry,work};
}
function checks(items:Array<{id?:number;name?:string;sha?:string;state:string;url?:string}>,statuses:Array<{context:string;state:string;target_url:string|null}>=[]) {
    vi.mocked(spawnCollect).mockImplementation(async(_file,args)=>({stdout:JSON.stringify(args[1]?.includes("check-runs") ? [{check_runs:items.map((c,i)=>({id:c.id??i+1,app:{id:1},name:c.name??"tests",head_sha:c.sha??"sha",status:c.state==="pending"?"in_progress":"completed",conclusion:c.state==="pending"?null:c.state,details_url:c.url??null}))}] : [{sha:"sha",statuses}]),stderr:""}));
}
describe("authorized checkpoint publication",()=>{
    it("publishes a meaningful checkpoint without final review and reuses its draft on retry",async()=>{
        const f=fixture();const signal=new AbortController().signal;
        await publishDraft(f.store,f.entry,f.work,"Partial implementation",signal);
        expect(f.store.work("work")?.publication).toMatchObject({sha:"sha",url,review:"pending",ci:null});
        await publishDraft(f.store,f.entry,f.work,"Same checkpoint",signal);
        expect(createDraftPullRequest).toHaveBeenCalledOnce();expect(pushBranch).toHaveBeenCalledOnce();
        expect(updateDraftPullRequest).toHaveBeenCalledTimes(2);
        expect(vi.mocked(createDraftPullRequest).mock.calls[0]![0].body).toContain("OAuth deferred");
    });
    it.each(["workspace_changes","report"] as const)("never publishes %s delivery",async deliverable=>{
        const f=fixture();f.entry.spec={...f.entry.spec!,deliverable};
        await expect(publishDraft(f.store,f.entry,f.work,"report",new AbortController().signal)).rejects.toThrow("not authorized");
        expect(pushBranch).not.toHaveBeenCalled();expect(createDraftPullRequest).not.toHaveBeenCalled();
    });
    it("retains push state after a lost PR creation response and avoids duplicate pushes",async()=>{
        const f=fixture();vi.mocked(createDraftPullRequest).mockRejectedValueOnce(new Error("response lost"));
        await expect(publishDraft(f.store,f.entry,f.work,"done",new AbortController().signal)).rejects.toThrow("response lost");
        expect(f.store.work("work")?.publication).toMatchObject({sha:"sha",url:null});
        await publishDraft(f.store,f.entry,f.work,"done",new AbortController().signal);
        expect(f.work.publication?.url).toBe(url);expect(pushBranch).toHaveBeenCalledOnce();
    });
    it("cannot push over an unrelated external head or update a merged PR",async()=>{
        const f=fixture();f.work.publication={entryId:f.entry.id,specHash:fingerprint(f.entry.spec),sha:"old",url,ci:null,review:"pending"};
        vi.mocked(spawnCollect).mockResolvedValue({stdout:JSON.stringify({...pr,headRefOid:"other"}),stderr:""});
        vi.mocked(git).mockImplementation(async(_cwd,args)=>{if(args[0]==="rev-parse")return "other";if(args[0]==="merge-base")throw new Error("diverged");return "diff";});
        await expect(publishDraft(f.store,f.entry,f.work,"done",new AbortController().signal)).rejects.toThrow("diverged");expect(pushBranch).not.toHaveBeenCalled();
        vi.mocked(spawnCollect).mockResolvedValue({stdout:JSON.stringify({...pr,state:"MERGED",mergeCommit:{oid:"merged"}}),stderr:""});
        await expect(publishDraft(f.store,f.entry,f.work,"done",new AbortController().signal)).rejects.toThrow("reconcile");
    });
});
describe("exact-commit CI evidence",()=>{
    it("keeps failing checks separate from pending checks and reads all pages",async()=>{
        const f=fixture();checks([{name:"core",state:"failure"},{name:"server",state:"failure"},{name:"docs",state:"pending"}]);
        const result=await readCi(f.work,"sha");expect(result.state).toBe("failed");expect(result.checks).toHaveLength(3);
        expect(result.detail).toContain("server: failure");expect(spawnCollect).toHaveBeenCalledWith("gh",expect.arrayContaining(["--paginate","--slurp"]),expect.any(Object));
    });
    it("cannot use a green check for a different commit",async()=>{
        const f=fixture();checks([{sha:"old-sha",state:"success"}]);expect(await readCi(f.work,"sha")).toMatchObject({state:"unavailable",detail:expect.stringContaining("different commit")});
    });
    it.each(["cancelled","timed_out","startup_failure","action_required"])("does not report %s as a code failure or pass",async state=>{
        const f=fixture();checks([{state}]);expect((await readCi(f.work,"sha")).state).toBe("unavailable");
    });
    it("leaves absent checks pending and a network failure unavailable",async()=>{
        const f=fixture();checks([]);expect((await readCi(f.work,"sha")).state).toBe("pending");
        vi.mocked(spawnCollect).mockRejectedValue(new Error("offline"));expect((await readCi(f.work,"sha")).state).toBe("unavailable");
    });
    it("uses the newest rerun of a check while retaining other applications' checks",async()=>{
        const f=fixture();checks([{id:1,state:"failure"},{id:2,state:"success"}]);expect((await readCi(f.work,"sha")).state).toBe("passed");
    });
    it("honors an external status failure even when check runs pass",async()=>{
        const f=fixture();checks([{state:"success"}],[{context:"external-ci",state:"failure",target_url:null}]);expect((await readCi(f.work,"sha")).state).toBe("failed");
    });
});
describe("external takeover and completion",()=>{
    it("fast-forwards an external draft update without force-resetting local work",async()=>{
        const f=fixture();f.work.publication={entryId:f.entry.id,specHash:fingerprint(f.entry.spec),sha:"sha",url,ci:null,review:"pending"};
        vi.mocked(spawnCollect).mockResolvedValue({stdout:JSON.stringify({...pr,headRefOid:"external"}),stderr:""});
        vi.mocked(git).mockImplementation(async(_cwd,args)=>{if(args[0]==="rev-parse")return "external";if(args[0]==="merge-base"&&args[2]==="external")throw new Error("remote ahead");return "";});
        await refreshDraftHead(f.work,new AbortController().signal);
        expect(git).toHaveBeenCalledWith("/work",["merge","--ff-only","external"],expect.any(AbortSignal));expect(pushBranch).not.toHaveBeenCalled();
    });
    it("completes a matching external merge and integrates main without republishing",async()=>{
        const f=fixture();f.work.publication={entryId:f.entry.id,specHash:fingerprint(f.entry.spec),sha:"sha",url,ci:null,review:"pending",handedOff:true};
        vi.mocked(spawnCollect).mockResolvedValue({stdout:JSON.stringify({...pr,state:"MERGED",headRefOid:"external",mergeCommit:{oid:"merged"}}),stderr:""});
        vi.mocked(git).mockImplementation(async(_cwd,args)=>args[0]==="rev-parse"?"external":"");
        expect(await reconcileMergedDraft(f.store,f.entry,f.work)).toContain("Externally merged as merged");
        expect(f.store.meta("output-sha:task")).toBe("merged");expect(f.work.publication.mergedSha).toBe("merged");
        expect(git).toHaveBeenCalledWith("/work",["merge","--no-edit","origin/main"]);expect(pushBranch).not.toHaveBeenCalled();
    });
    it("refuses completion when scope changed, work is dirty or external commits diverged",async()=>{
        const f=fixture();f.work.publication={entryId:f.entry.id,specHash:"different scope",sha:"sha",url,ci:null,review:"pending"};
        expect(await reconcileMergedDraft(f.store,f.entry,f.work)).toBeNull();expect(spawnCollect).not.toHaveBeenCalled();
        f.work.publication.specHash=fingerprint(f.entry.spec);
        vi.mocked(spawnCollect).mockResolvedValue({stdout:JSON.stringify({...pr,state:"MERGED",mergeCommit:{oid:"merged"}}),stderr:""});
        vi.mocked(hasUncommittedChangesExcluding).mockResolvedValue(true);
        await expect(reconcileMergedDraft(f.store,f.entry,f.work)).rejects.toThrow("dirty");
        expect(f.store.meta("output-sha:task")).toBeNull();
    });
});

it("recovers a legacy externally merged PR through retained ownership and recorded task SHA",async()=>{
    const f=fixture();f.store.setMeta("output-sha:task","sha");f.store.setMeta("workspace-owner:work","task");
    const merged={...pr,state:"MERGED",headRefOid:"external",mergeCommit:{oid:"merged"}};
    vi.mocked(spawnCollect).mockImplementation(async(_file,args)=>({stdout:JSON.stringify(args[1]==="list"?[merged]:merged),stderr:""}));
    vi.mocked(git).mockImplementation(async(_cwd,args)=>args[0]==="rev-parse"?"external":"");
    expect(await reconcileMergedDraft(f.store,f.entry,f.work)).toContain("Externally merged as merged");
    expect(git).toHaveBeenCalledWith("/work",["merge-base","--is-ancestor","sha","external"]);
    expect(f.work.publication).toMatchObject({taskSha:"sha",sha:"external",mergeState:"integrated"});
});
it("does not adopt an older PR without the retained task's ownership and output checkpoint",async()=>{
    const f=fixture();expect(await findLegacyPublication(f.store,f.entry,f.work)).toBeNull();expect(spawnCollect).not.toHaveBeenCalled();
});

it("resumes an interrupted target integration without trying to fast-forward backwards",async()=>{
    const f=fixture();f.work.publication={entryId:f.entry.id,specHash:fingerprint(f.entry.spec),sha:"sha",url,ci:null,review:"pending",mergedSha:"merged",mergeState:"integrating"};
    vi.mocked(getHeadSha).mockResolvedValue("integrated-local-merge");
    vi.mocked(spawnCollect).mockResolvedValue({stdout:JSON.stringify({...pr,state:"MERGED",headRefOid:"external",mergeCommit:{oid:"merged"}}),stderr:""});
    vi.mocked(git).mockImplementation(async(_cwd,args)=>args[0]==="rev-parse"?"external":"");
    expect(await reconcileMergedDraft(f.store,f.entry,f.work)).toContain("Externally merged");
    expect(git).not.toHaveBeenCalledWith("/work",["merge","--ff-only","external"]);
    expect(f.work.publication.mergeState).toBe("integrated");
});


it("stops CI observation on lease cancellation instead of masking it as unavailable",async()=>{
    const f=fixture();const controller=new AbortController();
    const stopped=Object.assign(new Error("Lease lost"),{code:"ABORT_ERR",stopKind:"lease_loss"});
    vi.mocked(spawnCollect).mockImplementationOnce(async(_file,_args,options)=>{
        expect(options.signal).toBe(controller.signal);controller.abort(stopped);throw stopped;
    });
    await expect(readCi(f.work,"sha",controller.signal)).rejects.toBe(stopped);
    expect(spawnCollect).toHaveBeenCalledOnce();
});
