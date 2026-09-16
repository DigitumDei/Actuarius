import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChannelType, type Client, type AnyThreadChannel } from "discord.js";
import pino from "pino";
import type { AppConfig } from "../src/config.js";
import type { AppDatabase } from "../src/db/database.js";
import type { RepoRow } from "../src/db/types.js";
import type { MemPalaceClient } from "../src/services/memPalaceClient.js";
import type { Entry, Work } from "../src/services/coordination/store.js";
import type { CoordinationHooks } from "../src/services/coordination/supervisor.js";
import { CoordinationBridge, type BridgeRunners } from "../src/discord/coordinationBridge.js";
import { git, prepareValidationWorkspace, resolveRef } from "../src/services/coordination/workspace.js";
import { spawnCollect } from "../src/utils/spawnCollect.js";
import { MAX_TASK_CONTEXT_BYTES } from "../src/services/coordination/context.js";
import { executionSchema } from "../src/services/coordination/contract.js";

vi.mock("../src/services/coordination/workspace.js",()=>({git:vi.fn(),resolveRef:vi.fn(),provisionWork:vi.fn(async()=>{}),prepareValidationWorkspace:vi.fn(async()=>"/validator")}));
vi.mock("../src/utils/spawnCollect.js",()=>({spawnCollect:vi.fn()}));
vi.mock("../src/services/gitWorkspaceService.js",()=>({buildRepoCheckoutPath:()=>"/checkout",detectDefaultBranch:vi.fn(),autoCommitAll:vi.fn(),getHeadSha:async()=>"output",pushBranch:vi.fn()}));
vi.mock("../src/services/githubAuthService.js",()=>({getGitHubCommandEnvironment:()=>({})}));
vi.mock("../src/services/githubService.js",()=>({listOpenIssues:async()=>[{number:1,title:"Large issue",body:"x".repeat(20000)}]}));

const close:Array<()=>void>=[];
beforeEach(()=>{vi.clearAllMocks();vi.mocked(git).mockResolvedValue("");vi.mocked(resolveRef).mockResolvedValue("merged-base");});
afterEach(()=>{for(const fn of close.splice(0))fn();});
function fixture(){
  const repo={id:1,full_name:"owner/repo",owner:"owner",repo:"repo",channel_id:"channel",guild_id:"guild"} as RepoRow;
  const thread={id:"thread",url:"thread-url",isThread:()=>true} as AnyThreadChannel;
  const threads=new Map<string,AnyThreadChannel>();
  const create=vi.fn(async({name}:{name:string})=>{const value={...thread,id:`thread-${threads.size}`,name} as AnyThreadChannel;threads.set(value.id,value);return value;});
  const channel={type:ChannelType.GuildText,threads:{fetchActive:async()=>({threads:{find:(fn:(t:AnyThreadChannel)=>boolean)=>[...threads.values()].find(fn)}}),create}};
  const client={channels:{fetch:async(id:string)=>id==="channel"?channel:(threads.get(id) ?? thread)}} as unknown as Client;
  const db={listAllRepos:()=>[repo],getRequestById:()=>({status:"queued"}),updateRequestStatus:vi.fn()} as unknown as AppDatabase;
  const text=vi.fn(async()=>"APPROVED\nAll checks passed.");
  const review=vi.fn<BridgeRunners["review"]>(async()=>({ready:true,text:"review",sha:"output"}));
  const bridge=new CoordinationBridge(client,{databasePath:":memory:",reposRootPath:"/repos",threadAutoArchiveMinutes:60} as AppConfig,db,{} as MemPalaceClient,pino({level:"silent"}),{text,parsePlan:()=>null,review,prepare:async()=>{}});
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
  return {bridge,work,other,repo,entry,dep,hooks,internals,text,review,create,db};
}

it("requires merged dependencies in the retained branch, not just origin/main",async()=>{
  const f=fixture();
  vi.mocked(git).mockImplementation(async(cwd,args)=>{if(cwd==="/consumer"&&args[0]==="merge-base")throw new Error("missing dependency");return "";});
  expect(await f.hooks.gate(f.entry,f.dep,"merged")).toBe(false);
  vi.mocked(git).mockResolvedValue("");
  expect(await f.hooks.gate(f.entry,f.dep,"merged")).toBe(true);
  expect(git).toHaveBeenCalledWith("/consumer",["merge-base","--is-ancestor","dependency-sha","HEAD"]);
});
it.each(["base_ref","integration_target"])("classifies missing %s after fetch as invalid input",async(field)=>{
  const f=fixture();
  if(field==="base_ref")vi.mocked(resolveRef).mockRejectedValueOnce(new Error("Needed a single revision"));
  else vi.mocked(git).mockImplementation(async(_cwd,args)=>{if(args[0]==="rev-parse")throw new Error("Needed a single revision");return "";});
  await expect(f.hooks.check(f.entry.spec!)).rejects.toMatchObject({message:expect.stringContaining(`workspace.${field}`)});
});
it("preserves fetch failures as retryable infrastructure errors",async()=>{
  const f=fixture();const offline=new Error("network unavailable");vi.mocked(git).mockRejectedValueOnce(offline);
  await expect(f.hooks.check(f.entry.spec!)).rejects.toBe(offline);
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

it("queues coordinated adversarial review progress for the work thread",async()=>{
  const f=fixture();f.entry.spec={...f.entry.spec!,action:"review"};f.entry.task={task_id:"task"} as Entry["task"];
  f.review.mockImplementationOnce(async(_work,_repo,_signal,_existingOnly,onProgress)=>{
    await onProgress?.({type:"analyzer-start"});
    await onProgress?.({type:"round-start",round:1,maxRounds:2});
    await onProgress?.({type:"round-complete",round:1,maxRounds:2,consensusReached:false});
    await onProgress?.({type:"summarizer-start"});
    return {ready:true,text:"review",sha:"output"};
  });
  await f.internals.execute(f.entry,f.work,new AbortController().signal);
  const progress=f.bridge.store.outbox().map(item=>String(item.payload.content));
  expect(progress).toEqual([
    "Task task · step 0: analyzing the change intent.",
    "Task task · step 0: review round 1/2 started.",
    "Task task · step 0: review round 1/2 completed without consensus.",
    "Task task · step 0: synthesizing the final review verdict."
  ]);
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

it("single-flights concurrent thread creation for separate work snapshots",async()=>{
  const f=fixture();const w=f.bridge.store.register({work_id:"concurrent",repository:f.repo.full_name,base_ref:"main",integration_target:"main"});
  const [a,b]=await Promise.all([f.internals.thread({...w},f.repo),f.internals.thread({...w},f.repo)]);
  expect(a.id).toBe(b.id);expect(f.create).toHaveBeenCalledTimes(1);
});

it("returns an ask answer without scheduling a verification continuation",async()=>{
  const f=fixture();f.entry.spec={...f.entry.spec!,action:"ask",deliverable:"report"};
  f.text.mockResolvedValue("Here is the answer.");const result=await f.internals.execute(f.entry,f.work,new AbortController().signal);
  expect(result).toEqual({result:"Here is the answer."});expect(f.text.mock.calls[0]?.[0]).toMatchObject({prompt:expect.stringContaining("Answer the user's question")});
});

it("verifies against this task's baseline and accepts approval explanations",async()=>{
  const f=fixture();f.entry.action="verify-result";f.entry.checkpoint="done";f.bridge.store.setMeta(`task-baseline:${f.entry.id}`,"task-start");
  const result=await f.internals.execute(f.entry,f.work,new AbortController().signal);
  expect(result.result).toBe("done");expect(git).toHaveBeenCalledWith("/consumer",["diff","task-start","--",".",":(exclude)docs/reviews/**"]);
});

it("handles large issue summary context without provisioning a worktree",async()=>{
  const f=fixture();f.entry.spec={...f.entry.spec!,action:"report",deliverable:"report"};f.work.path=null;f.work.request_id=null;f.entry.thread_id=null;
  f.bridge.store.setMeta(`issue-summary:${f.entry.id}`,"1");f.text.mockResolvedValue("summary");
  const result=await f.internals.execute(f.entry,f.work,new AbortController().signal);
  expect(result.result).toBe("summary");expect(f.text.mock.calls[0]?.[0]).toMatchObject({cwd:"/checkout",prompt:expect.stringContaining("x".repeat(20000))});expect(f.create).not.toHaveBeenCalled();
});

it("allows deletion only when an exact squash-merged HEAD is integrated",async()=>{
  const f=fixture();f.entry.phase="failed";f.bridge.store.save(f.entry);
  vi.mocked(git).mockImplementation(async(_cwd,args)=>{if(args[0]==="merge-base" && args[2]==="output")throw new Error("not ancestor");return "";});
  vi.mocked(spawnCollect).mockResolvedValue({stdout:JSON.stringify({state:"MERGED",headRefOid:"output",mergeCommit:{oid:"squashed"}}),stderr:""} as Awaited<ReturnType<typeof spawnCollect>>);
  await f.bridge.closeForDeletion("thread");expect(f.bridge.store.work(f.work.work_id)?.closed).toBe(true);
  expect(git).toHaveBeenCalledWith("/consumer",["merge-base","--is-ancestor","squashed","merged-base"]);
});


it("provides the original task scope to clarification, validation, and follow-up execution", async () => {
  const f=fixture();
  const original={...f.entry.spec!,requirements:["Replace Gemini with Antigravity CLI"],acceptance_criteria:["Existing authentication works"]};
  f.bridge.store.add({id:"original",source:"background",sender:"sender",wing:"wing_repo",description:"",work_id:f.work.work_id,spec:original,phase:"input_required"});
  f.bridge.store.setMeta(`workspace-owner:${f.work.work_id}`,"original");
  f.entry.spec={...f.entry.spec!,action:"ask",deliverable:"report",requirements:["Read the active task from AgentPalace"]};
  const brief={action:"ask",requirements:["Read requirements of task original from AgentPalace and report them"],acceptance_criteria:["Report accurately identifies the retrieved task and requirements"],deliverable:"report"};
  f.text.mockResolvedValueOnce(JSON.stringify(brief));
  expect(await f.hooks.clarify(f.entry,"Read the active task",new AbortController().signal)).toEqual(brief);
  f.text.mockResolvedValueOnce('{"ready":true,"questions":[]}');
  await f.hooks.validate(f.entry,new AbortController().signal);
  f.text.mockResolvedValueOnce("Retrieved task original");
  await f.internals.execute(f.entry,f.work,new AbortController().signal);
  for(const [input] of f.text.mock.calls) expect(input.prompt).toContain("Replace Gemini with Antigravity CLI");
});


it("finds a stalled task across repository workspaces before a root request is registered", async () => {
  const f=fixture();
  const original={...f.entry.spec!,requirements:["Replace Gemini with Antigravity CLI"],acceptance_criteria:["Do not publish a PR"]};
  f.entry.spec=original; f.entry.phase="input_required"; f.bridge.store.save(f.entry);
  f.bridge.store.setMeta(`workspace-owner:${f.work.work_id}`,f.entry.id);
  const foreign=f.bridge.store.register({work_id:"foreign",repository:"owner/other",base_ref:"main",integration_target:"main"});
  f.bridge.store.add({id:"foreign-task",source:"background",sender:"sender",wing:"wing_other",description:"",work_id:foreign.work_id,spec:{...original,workspace:{work_id:foreign.work_id},requirements:["Unrelated private work"]},phase:"input_required"});
  const rootSpec=executionSchema.parse({version:1,executor:"actuarius",action:"ask",workspace:{work_id:"root-request",repository:"OWNER/REPO",base_ref:"main",integration_target:"main"},requirements:["Pull the current task and update its acceptance criteria to allow a draft PR"],acceptance_criteria:["Answer accurately"],deliverable:"report"});
  const root=f.bridge.store.add({id:"root-request",source:"discord",sender:"discord:user",wing:"wing_repo",description:"root request",work_id:"root-request",spec:rootSpec});
  expect(f.bridge.store.work(root.work_id!)).toBeNull();
  f.text.mockResolvedValueOnce('{"ready":true,"questions":[]}');
  await f.hooks.validate(root,new AbortController().signal);
  f.text.mockResolvedValueOnce(JSON.stringify({action:"ask",requirements:rootSpec.requirements,acceptance_criteria:rootSpec.acceptance_criteria,deliverable:"report"}));
  await f.hooks.clarify(root,"The stalled task in this repo",new AbortController().signal);
  const rootWork=f.bridge.store.register(rootSpec.workspace!);rootWork.path="/root-request";rootWork.thread_id="thread";rootWork.request_id=1;f.bridge.store.saveWork(rootWork);
  f.text.mockResolvedValueOnce("Found the stalled task");
  await f.internals.execute(root,rootWork,new AbortController().signal);
  for(const [input] of f.text.mock.calls) {
    expect(input.prompt).toContain("Replace Gemini with Antigravity CLI");
    expect(input.prompt).toContain('"work_id":"consumer"');
    expect(input.prompt).not.toContain("Unrelated private work");
  }
  expect(root.dependencies).toEqual([]);
  expect(root.spec?.workspace?.work_id).toBe("root-request");
  expect(rootWork.branch).not.toBe(f.work.branch);
  expect(f.bridge.store.meta(`workspace-owner:${f.work.work_id}`)).toBe(f.entry.id);
  expect(f.bridge.store.get(f.entry.id)?.phase).toBe("input_required");
});


it("bounds complete serialized context including multibyte and escaped text", async () => {
  const f=fixture();
  const large='"\\\n' + String.fromCodePoint(0x1f680).repeat(10000);
  for(let i=0;i<15;i++) f.bridge.store.add({id:`large-${i}`,source:"background",sender:"agent",wing:"wing_repo",description:"",work_id:f.work.work_id,phase:"input_required",reason:large.repeat(4),result:large,spec:{...f.entry.spec!,requirements:[large.repeat(2)],acceptance_criteria:[large.repeat(2)]}});
  f.bridge.store.setMeta(`workspace-owner:${f.work.work_id}`,"large-0");
  f.text.mockResolvedValueOnce('{"ready":true,"questions":[]}');
  await f.hooks.validate(f.entry,new AbortController().signal);
  const serialized=f.text.mock.calls[0]![0].prompt.split("Work context:\n").at(-1)!;
  const context=JSON.parse(serialized);
  expect(Buffer.byteLength(serialized,"utf8")).toBeLessThanOrEqual(MAX_TASK_CONTEXT_BYTES);
  expect(context.tasks[0].id).toBe("large-0");
  expect(context.tasks[0].spec.truncated).toBe(true);
  expect(context.tasks[0].reason).toContain("[truncated]");
  expect(context.tasks.length + context.omitted_tasks).toBe(15);
  expect(context.omitted_tasks).toBeGreaterThan(3);
});
it("includes failed retained owners but excludes unrelated failed history", async () => {
  const f=fixture();
  for(const id of ["failed-owner","old-failure"]) f.bridge.store.add({id,source:"background",sender:"agent",wing:"wing_repo",description:"",work_id:f.other.work_id,phase:"failed",spec:{...f.entry.spec!,workspace:{work_id:f.other.work_id}}});
  f.bridge.store.setMeta(`workspace-owner:${f.other.work_id}`,"failed-owner");
  f.text.mockResolvedValueOnce('{"ready":true,"questions":[]}');
  await f.hooks.validate(f.entry,new AbortController().signal);
  const context=JSON.parse(f.text.mock.calls[0]![0].prompt.split("Work context:\n").at(-1)!);
  expect(context.tasks.map((task:{id:string})=>task.id)).toContain("failed-owner");
  expect(context.tasks.map((task:{id:string})=>task.id)).not.toContain("old-failure");
});
