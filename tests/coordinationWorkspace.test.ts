import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationStore } from "../src/services/coordination/store.js";
import { git, provisionWork } from "../src/services/coordination/workspace.js";
vi.mock("../src/services/githubAuthService.js", () => ({ configureRepositoryGitAuth: async () => { } }));
vi.mock("../src/services/gitWorkspaceService.js", () => ({
    buildRepoCheckoutPath: (root: string, owner: string, repo: string) => join(root, owner, repo),
    ensureRepoCheckedOutToMaster: async () => ({})
}));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0))
    await fn(); });
it("reuses a worktree after restart and preserves dirty files and its original base", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-workspace-"));
    const base = join(root, "owner", "repo");
    await mkdir(base, { recursive: true });
    await git(base, ["init", "-b", "main"]);
    await git(base, ["config", "user.name", "Test"]);
    await git(base, ["config", "user.email", "test@example.invalid"]);
    await writeFile(join(base, "README.md"), "original");
    await git(base, ["add", "."]);
    await git(base, ["commit", "-m", "initial"]);
    const original = await git(base, ["rev-parse", "HEAD"]);
    await git(base, ["update-ref", "refs/remotes/origin/main", original]);
    let store = new CoordinationStore(join(root, "queue.sqlite"));
    cleanups.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
    const identity = { owner: "owner", repo: "repo", fullName: "owner/repo" };
    const work = store.register({ work_id: "shared", repository: "owner/repo", base_ref: "main", integration_target: "main" });
    await provisionWork(store, root, identity, work);
    await writeFile(join(work.path!, "README.md"), "valuable unfinished work");
    store.close();
    store = new CoordinationStore(join(root, "queue.sqlite"));
    const recovered = store.register({ work_id: "shared" });
    await provisionWork(store, root, identity, recovered);
    expect(recovered.path).toBe(work.path);
    expect(recovered.branch).toBe(work.branch);
    expect(recovered.base_sha).toBe(original);
    expect(await readFile(join(recovered.path!, "README.md"), "utf8")).toBe("valuable unfinished work");
    await git(recovered.path!, ["switch", "-c", "unexpected"]);
    await expect(provisionWork(store, root, identity, recovered)).rejects.toThrow("branch changed");
});
