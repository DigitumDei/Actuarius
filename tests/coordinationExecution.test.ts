import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChannelType, type Client, type AnyThreadChannel } from "discord.js";
import pino from "pino";
import type { AppConfig } from "../src/config.js";
import type { AppDatabase } from "../src/db/database.js";
import type { RepoRow } from "../src/db/types.js";
import type { MemPalaceClient } from "../src/services/memPalaceClient.js";
import type { Entry, Work } from "../src/services/coordination/store.js";
import type { CoordinationHooks } from "../src/services/coordination/supervisor.js";
import { CoordinationBridge } from "../src/discord/coordinationBridge.js";
import { git, prepareValidationWorkspace, resolveRef } from "../src/services/coordination/workspace.js";
import { spawnCollect } from "../src/utils/spawnCollect.js";
import { executionSchema } from "../src/services/coordination/contract.js";

vi.mock("../src/services/coordination/workspace.js",()=>({git:vi.fn(),resolveRef:vi.fn(),provisionWork:vi.fn(async()=>{}),prepareValidationWorkspace:vi.fn(async()=>"/validator")}));
vi.mock("../src/utils/spawnCollect.js",()=>({spawnCollect:vi.fn()}));
vi.mock("../src/services/gitWorkspaceService.js",()=>({buildRepoCheckoutPath:()=>"/checkout",detectDefaultBranch:vi.fn(),autoCommitAll:vi.fn(),getHeadSha:async()=>"output",pushBranch:vi.fn()}));
vi.mock("../src/services/githubAuthService.js",()=>({getGitHubCommandEnvironment:()=>({})}));

const close:Array<()=>void>=[];
beforeEach(()=>{vi.clearAllMocks();vi.mocked(git).mockResolvedValue("");vi.mocked(resolveRef).mockResolvedValue("merged-base");});
afterEach(()=>{for(const fn of close.splice(0))fn();});
function fixture(){
  const repo={id:1,full_name:"owner/repo",owner:"owner",repo:"repo",channel_id:"channel",guild_id:"guild"} as RepoRow;
  const thread={id:"thread",url:"thread-url",isThread:()=>true} as AnyThreadChannel;
  const threads=new Map<string,AnyThreadChannel>();
  const create=vi.fn(async({name}:{name:string})=>{const value={...thread,id:`thread-${threads.size}`,name} as AnyThreadChannel;threads.set(value.id,value);return value;});
  const channel={type:ChannelType.GuildText,threads:{fetchActive:async()=>({threads:{find:(fn:(t:AnyThreadChannel)=>boolean)=>[...threads.values()].find(fn)}}),create}};
  const client={channels:{fetch:async(id:string)=>id==="channel"?channel:thread}} as unknown as Client;
  const db={listAllRepos:()=>[repo],getRequestById:()=>({status:"queued"}),updateRequestStatus:vi.fn()} as unknown as AppDatabase;
  const text=vi.fn(async()=>"APPROVED\nAll checks passed.");
  const bridge=new CoordinationBridge(client,{databasePath:":memory:",reposRootPath:"/repos",threadAutoArchiveMinutes:60} as AppConfig,db,{} as MemPalaceClient,pino({level:"silent"}),{text,parsePlan:()=>null,review:async()=>({ready:true,text:"review",sha:"output"}),prepare:async()=>{}});
  close.push(()=>bridge.store.close());
  const work=bridge.store.register({work_id:"consumer",repository:repo.full_name,base_ref:"main",integration_target:"main"});
  work.path="/consumer";work.thread_id="thread";work.request_id=1;bridge.store.saveWork(work);
  const other=bridge.store.register({work_id:"dependency",repository:repo.full_name,base_ref:"main",integration_target:"main"});other.path="/dependency";bridge.store.saveWork(other);
  const spec=executionSchema.parse({version:1,executor:"actuarius",action:"plan",workspace:{work_id:"consumer"},requirements:["Implement"],acceptance_criteria:["Pass"],deliverable:"workspace_changes"});
  const entry=bridge.store.add({id:"consumer",source:"background",description:"",sender:"sender",wing:"wing_coordination",spec,work_id:work.work_id});
  const dep=bridge.store.add({id:"dependency",source:"background",description:"",sender:"sender",wing:"wing_coordination",work_id:other.work_id});
  bridge.store.setMeta(`output-sha:${dep.id}`,"dependency-sha");
  const hooks=(bridge.supervisor as unknown as {hooks:CoordinationHooks}).hooks;
  const internals=bridge as unknown as {thread(w:Work,r:RepoRow):Promise<AnyThreadChannel>;execute(e:Entry,w:Work|null,s:AbortSignal):Promise<{result:string;next?:string;checkpoint?:string}>};
  return {bridge,work,other,repo,entry,dep,hooks,internals,text,create,db};
}

it("requires merged dependencies in the retained branch, not just origin/main",async()=>{
  const f=fixture();
  vi.mocked(git).mockImplementation(async(cwd,args)=>{if(cwd==="/consumer"&&args[0]==="merge-base")throw new Error("missing dependency");return "";});
  expect(await f.hooks.gate(f.entry,f.dep,"merged")).toBe(false);
  vi.mocked(git).mockResolvedValue("");
  expect(await f.hooks.gate(f.entry,f.dep,"merged")).toBe(true);
  expect(git).toHaveBeenCalledWith("/consumer",["merge-base","--is-ancestor","dependency-sha","HEAD"]);
});

it("checks an already frozen base even before its worktree is created",async()=>{
  const f=fixture();f.work.path=null;f.work.base_sha="old-base";f.bridge.store.saveWork(f.work);
  vi.mocked(git).mockImplementation(async(_cwd,args)=>{if(args.at(-1)==="old-base")throw new Error("missing dependency");return "";});
  expect(await f.hooks.gate(f.entry,f.dep,"merged")).toBe(false);
});

it("evaluates merged and release gates for a parent without a workspace",async()=>{
  const f=fixture();f.entry.work_id=null;
  f.entry.spec=executionSchema.parse({version:1,executor:"actuarius",action:"workflow",requirements:["Summarize"],acceptance_criteria:["Released"],deliverable:"report",gates:[{task_id:"dependency",kind:"release",ref:"v1"}]});
  f.dep.task={task_id:"dependency"} as Entry["task"];
  vi.mocked(spawnCollect).mockResolvedValue({stdout:JSON.stringify({isDraft:false,tagName:"v1"}),stderr:""} as Awaited<ReturnType<typeof spawnCollect>>);
  expect(await f.hooks.gate(f.entry,f.dep,"merged")).toBe(true);
  expect(await f.hooks.gate(f.entry,f.dep,"release")).toBe(true);
  expect(resolveRef).toHaveBeenCalledWith("/checkout","main");
});

it("accepts an iterative approval with explanation without scheduling another implementation",async()=>{
  const f=fixture();f.entry.action="plan-verify";
  f.entry.checkpoint=JSON.stringify({overview:"Plan",tasks:[{title:"Task",description:"Do it"}],index:0,attempts:0,baseline:"base",output:"done",feedback:"",results:[]});
  const result=await f.internals.execute(f.entry,f.work,new AbortController().signal);
  expect(result.next).toBeUndefined();expect(result.result).toContain("done");
});

it("keeps the first implementation baseline through rejected tweaks and resets it for the next task",async()=>{
  const f=fixture(); f.entry.action="plan-implement";
  f.entry.checkpoint=JSON.stringify({overview:"Plan",tasks:[{title:"One",description:"Do it"},{title:"Two",description:"Next"}],index:0,attempts:1,baseline:"original-base",output:"rejected",feedback:"Fix it",results:[]});
  const implemented=await f.internals.execute(f.entry,f.work,new AbortController().signal);
  expect(JSON.parse(implemented.checkpoint!).baseline).toBe("original-base");
  f.entry.action="plan-verify";f.entry.checkpoint=implemented.checkpoint!;
  const verified=await f.internals.execute(f.entry,f.work,new AbortController().signal);
  expect(git).toHaveBeenCalledWith("/consumer",["diff","original-base","--",".",":(exclude)docs/reviews/**"]);
  expect(JSON.parse(verified.checkpoint!).baseline).toBe("");
});

it("synchronizes shared request rows for starts, completion, failure, and cancellation",async()=>{
  const f=fixture(); f.entry.spec={...f.entry.spec!,action:"review"};
  await f.internals.execute(f.entry,f.work,new AbortController().signal);
  expect(f.db.updateRequestStatus).toHaveBeenCalledWith(1,"running");
  for (const phase of ["completed","interrupted","cancelled","failed"]) {
    f.entry.phase=phase;f.bridge.store.save(f.entry);f.hooks.syncRequests!();
    expect(f.db.updateRequestStatus).toHaveBeenLastCalledWith(1,phase==="completed"?"succeeded":"failed");
  }
});

it("uses a Git validation workspace for validation and parent summaries",async()=>{
  const f=fixture();f.text.mockResolvedValueOnce('{"ready":true,"questions":[]}');
  await f.hooks.validate(f.entry,new AbortController().signal);
  await f.internals.execute(f.entry,null,new AbortController().signal);
  expect(prepareValidationWorkspace).toHaveBeenCalledTimes(2);
  expect(f.text.mock.calls.every(([input])=> (input as {cwd:string}).cwd==="/validator")).toBe(true);
});

it("keeps work IDs sharing a long prefix in separate recoverable Discord threads",async()=>{
  const f=fixture();const prefix="x".repeat(100);
  const work1=f.bridge.store.register({work_id:`${prefix}one`,repository:f.repo.full_name,base_ref:"main",integration_target:"main"});
  const work2=f.bridge.store.register({work_id:`${prefix}two`,repository:f.repo.full_name,base_ref:"main",integration_target:"main"});
  const one=await f.internals.thread(work1,f.repo);const two=await f.internals.thread(work2,f.repo);
  expect(one.id).not.toBe(two.id);expect(one.name.length).toBeLessThanOrEqual(100);
  work1.thread_id=null;expect((await f.internals.thread(work1,f.repo)).id).toBe(one.id);
  expect(f.create).toHaveBeenCalledTimes(2);
});
