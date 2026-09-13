import {afterEach,expect,it,vi} from "vitest";
import pino from "pino";
import {runProviderRequest,type ProviderRunnerConfig} from "../src/utils/runProviderRequest.js";
import {setProviderGateEnabled} from "../src/services/providerGate.js";
import {spawnCollectWithTransport} from "../src/utils/spawnCollect.js";
vi.mock("../src/utils/spawnCollect.js",async(importOriginal)=>({...await importOriginal<typeof import("../src/utils/spawnCollect.js")>(),spawnCollectWithTransport:vi.fn()}));
afterEach(()=>{setProviderGateEnabled(false);vi.useRealTimers();vi.clearAllMocks();});
const config={binary:"fake",extraArgs:[],logLabel:"Fake",makeError:(_code:string,message:string)=>new Error(message)} as ProviderRunnerConfig;
it.each([false,true])("preserves legacy concurrency when gate enabled=%s",async(enabled)=>{
  setProviderGateEnabled(enabled);const release:Array<()=>void>=[];
  vi.mocked(spawnCollectWithTransport).mockImplementation(()=>new Promise(resolve=>release.push(()=>resolve({stdout:"answer",stderr:""}))));
  const run=()=>runProviderRequest({prompt:"question",cwd:".",timeoutMs:60000},config,pino({level:"silent"}));
  const first=run();const second=run();
  await vi.waitFor(()=>expect(release).toHaveLength(enabled?1:2));
  release[0]!();await first;
  await vi.waitFor(()=>expect(release).toHaveLength(2));release[1]!();await second;
});
