import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CoordinationStore } from "../src/services/coordination/store.js";
import { executionSchema, fingerprint } from "../src/services/coordination/contract.js";
import { git } from "../src/services/coordination/workspace.js";
import { getHeadSha } from "../src/services/gitWorkspaceService.js";
import { reconcileMergedDraft, refreshDraftHead } from "../src/services/coordination/publication.js";
const state=vi.hoisted(()=>({pr:{} as Record<string,unknown>}));
vi.mock("../src/utils/spawnCollect.js",async original=>{
    const actual=await original<typeof import("../src/utils/spawnCollect.js")>();
    return {...actual,spawnCollect:vi.fn(async(file:string,args:string[],options:Parameters<typeof actual.spawnCollect>[2])=>
        file==="gh" ? {stdout:JSON.stringify(state.pr),stderr:""} : actual.spawnCollect(file,args,options))};
});
vi.mock("../src/services/githubAuthService.js",()=>({getGitHubCommandEnvironment:()=>({})}));
const clean:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const finish of clean.splice(0))await finish();});
async function fixture(){
    const root=await mkdtemp(join(tmpdir(),"publication-real-git-"));
    clean.push(()=>rm(root,{recursive:true,force:true}));
    const local=join(root,"local"),external=join(root,"external"),origin=join(root,"origin.git");
    await mkdir(local);await git(root,["init","--bare",origin]);await git(local,["init","-b","main"]);
    for(const [key,value] of [["user.name","Workflow test"],["user.email","test@example.invalid"]])await git(local,["config",key!,value!]);
    await writeFile(join(local,"base.txt"),"base");await git(local,["add","base.txt"]);await git(local,["commit","-m","Base"]);
    await git(local,["remote","add","origin",origin]);await git(local,["push","origin","main"]);
    await git(local,["checkout","-b","actuarius/work"]);await writeFile(join(local,"foundation.txt"),"foundation");
    await git(local,["add","foundation.txt"]);await git(local,["commit","-m","Foundation"]);const taskSha=await getHeadSha(local);
    await git(local,["push","origin","actuarius/work"]);await git(root,["clone","-b","actuarius/work",origin,external]);
    for(const [key,value] of [["user.name","External test"],["user.email","external@example.invalid"]])await git(external,["config",key!,value!]);
    await writeFile(join(external,"fix.txt"),"external fix");await git(external,["add","fix.txt"]);await git(external,["commit","-m","External fix"]);
    const externalSha=await getHeadSha(external);await git(external,["push","origin","actuarius/work"]);
    await git(origin,["update-ref","refs/pull/12/head",externalSha]);
    await git(external,["checkout","main"]);await git(external,["merge","--squash","actuarius/work"]);await git(external,["commit","-m","Squash accepted foundation"]);
    const mergeSha=await getHeadSha(external);await git(external,["push","origin","main"]);
    const store=new CoordinationStore(":memory:");clean.unshift(async()=>{store.close();});
    const spec=executionSchema.parse({version:1,executor:"actuarius",action:"handoff",workspace:{work_id:"work",repository:"owner/repo",base_ref:"main",integration_target:"main"},requirements:["Foundation"],acceptance_criteria:["Reviewed externally"],deliverable:"draft_pr"});
    const entry=store.add({id:"task",source:"background",description:"",spec,sender:"sender",wing:"wing_repo",work_id:"work"});
    const work=store.register(spec.workspace!);work.path=local;work.branch="actuarius/work";
    work.publication={entryId:entry.id,specHash:fingerprint(spec),sha:taskSha,url:"https://github.com/owner/repo/pull/12",ci:null,review:"pending",handedOff:true};
    store.saveWork(work);
    state.pr={number:12,url:work.publication.url,state:"MERGED",isDraft:false,headRefName:work.branch,headRefOid:externalSha,baseRefName:"main",mergeCommit:{oid:mergeSha}};
    return {store,entry,work,local,taskSha,externalSha,mergeSha};
}
it("preserves external commits, integrates a squash merge and safely repeats completion after a restart",async()=>{
    const f=await fixture();const signal=new AbortController().signal;
    expect(await reconcileMergedDraft(f.store,f.entry,f.work,signal)).toContain(f.mergeSha);
    expect(await readFile(join(f.local,"foundation.txt"),"utf8")).toBe("foundation");
    expect(await readFile(join(f.local,"fix.txt"),"utf8")).toBe("external fix");
    await git(f.local,["merge-base","--is-ancestor",f.mergeSha,"HEAD"]);
    await git(f.local,["merge-base","--is-ancestor",f.externalSha,"HEAD"]);
    const integrated=await getHeadSha(f.local);
    expect(f.store.work("work")?.publication).toMatchObject({mergeState:"integrated",integratedHead:integrated});
    expect(f.store.meta("output-sha:task")).toBe(f.mergeSha);
    await reconcileMergedDraft(f.store,f.entry,f.store.work("work")!,signal);
    expect(await getHeadSha(f.local)).toBe(integrated);
},20000);
it("refuses divergent committed local work without resetting it or completing the task",async()=>{
    const f=await fixture();await writeFile(join(f.local,"retained.txt"),"unpublished local work");
    await git(f.local,["add","retained.txt"]);await git(f.local,["commit","-m","Retain local work"]);const before=await getHeadSha(f.local);
    await expect(reconcileMergedDraft(f.store,f.entry,f.work,new AbortController().signal)).rejects.toThrow();
    expect(await getHeadSha(f.local)).toBe(before);expect(await readFile(join(f.local,"retained.txt"),"utf8")).toBe("unpublished local work");
    expect(f.store.meta("output-sha:task")).toBeNull();
},20000);
it("fast-forwards a compatible external draft update without publication",async()=>{
    const f=await fixture();state.pr={...state.pr,state:"OPEN",isDraft:true,mergeCommit:null};
    await refreshDraftHead(f.work,new AbortController().signal);
    expect(await getHeadSha(f.local)).toBe(f.externalSha);expect(await readFile(join(f.local,"fix.txt"),"utf8")).toBe("external fix");
},20000);
