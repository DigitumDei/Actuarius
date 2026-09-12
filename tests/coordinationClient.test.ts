import { expect, it, vi } from "vitest";
import { CoordinationClient } from "../src/services/coordination/client.js";

it("preserves source authority and selects a write wing at that authority",async()=>{
  const call=vi.fn(async(name:string)=>name.endsWith("task_list") ? {
    tasks:[{task_id:"local-task"}],next_cursor:null,
    remote_tasks:{hub:{tasks:[{task_id:"remote-task"}],next_cursor:null}}
  } : {wings:[{wing:"wing_repo",destination:"local"},{wing:"wing_coordination",destination:"remote:hub"}]});
  const client=new CoordinationClient({coordinationCall:call});
  const page=await client.page("");
  expect(page.authorities).toEqual({"local-task":"local","remote-task":"remote:hub"});
  expect(await client.creationWing("wing_coordination","remote:hub")).toBe("wing_coordination");
  expect(await client.creationWing("wing_repo","remote:hub")).toBe("wing_coordination");
  await expect(client.creationWing("wing_repo","remote:missing")).rejects.toThrow("No coordination write route");
});
