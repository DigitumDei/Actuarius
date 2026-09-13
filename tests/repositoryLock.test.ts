import {expect,it} from "vitest";
import {withRepositoryLock} from "../src/services/gitWorkspaceService.js";
it("serializes shared checkout operations while allowing nested acquisition",async()=>{
  const calls:string[]=[];let release!:()=>void;
  const first=withRepositoryLock("/repo",async()=>{
    calls.push("first");await withRepositoryLock("/repo",async()=>{calls.push("nested");});
    await new Promise<void>(resolve=>{release=resolve;});
  });
  await new Promise(resolve=>setTimeout(resolve,0));
  const second=withRepositoryLock("/repo",async()=>{calls.push("second");});
  await new Promise(resolve=>setTimeout(resolve,0));expect(calls).toEqual(["first","nested"]);
  release();await Promise.all([first,second]);expect(calls).toEqual(["first","nested","second"]);
});
