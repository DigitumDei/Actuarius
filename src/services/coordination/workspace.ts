import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fingerprint } from "./contract.js";
import type { CoordinationStore, Work } from "./store.js";
import { buildRepoCheckoutPath, ensureRepoCheckedOutToMaster, type RepoIdentity } from "../gitWorkspaceService.js";
import { configureRepositoryGitAuth } from "../githubAuthService.js";
import { spawnCollect } from "../../utils/spawnCollect.js";
export async function git(cwd: string, args: string[]): Promise<string> {
    const result = await spawnCollect("git", ["-C", cwd, ...args], { cwd, timeoutMs: 120000, maxBuffer: 4 * 1024 * 1024 });
    return result.stdout.trim();
}
export async function resolveRef(cwd: string, ref: string): Promise<string> {
    const target = /^[a-f0-9]{40}$/i.test(ref) ? ref : ref.startsWith("origin/") ? ref : `origin/${ref}`;
    return git(cwd, ["rev-parse", "--verify", "--end-of-options", `${target}^{commit}`]);
}
/** An isolated Git repository supports validation with providers requiring a Git cwd. */
export async function prepareValidationWorkspace(root: string): Promise<string> {
    const path = join(root, ".coordination-validator");
    await mkdir(path, { recursive: true });
    await git(path, ["init", "--quiet"]);
    return path;
}
export async function provisionWork(store: CoordinationStore, root: string, identity: RepoIdentity, work: Work): Promise<Work> {
    const base = buildRepoCheckoutPath(root, identity.owner, identity.repo);
    if (work.path && existsSync(work.path)) {
        const branch = await git(work.path, ["symbolic-ref", "--short", "HEAD"]);
        if (branch !== work.branch)
            throw new Error("Registered worktree branch changed; inspect before resuming");
        const common = await git(work.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        const expected = await git(base, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        if (common !== expected)
            throw new Error("Worktree belongs to a different repository");
        return work;
    }
    if (work.path)
        throw new Error("Registered worktree is missing; explicit recovery is required");
    await ensureRepoCheckedOutToMaster(root, identity);
    if (!work.base_sha) {
        work.base_sha = await resolveRef(base, work.base_ref);
        store.saveWork(work);
    }
    const path = join(root, ".worktrees", "coordination", fingerprint(work.work_id).slice(0, 24));
    await mkdir(dirname(path), { recursive: true });
    if (existsSync(path)) {
        // Reconcile a crash after Git created the worktree but before SQLite recorded it.
        if (await git(path, ["symbolic-ref", "--short", "HEAD"]) !== work.branch)
            throw new Error("Workspace path collision");
    }
    else {
        let branchExists = false;
        try {
            await git(base, ["show-ref", "--verify", `refs/heads/${work.branch}`]);
            branchExists = true;
        }
        catch { /* new branch */ }
        await git(base, ["worktree", "add", ...(branchExists ? [path, work.branch] : ["-b", work.branch, path, work.base_sha])]);
    }
    await configureRepositoryGitAuth(path);
    work.path = path;
    store.saveWork(work);
    return work;
}
