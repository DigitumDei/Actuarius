import { constants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const OPENCODE_PLAN_OC_AGENT = "actuarius-plan-oc";
export const OPENCODE_IMPLEMENT_OC_AGENT = "actuarius-implement-oc";

export type OpencodePlanOcRole = "planner" | "implementer";

export interface OpencodePlanAgentModels {
  planner: string | null;
  implementer: string | null;
}

export interface OpencodePlanAgentState {
  configDir: string;
  models: OpencodePlanAgentModels;
}

export interface OpencodePlanAgentSnapshot extends OpencodePlanAgentState {
  cleanup: () => Promise<void>;
}

export interface OpencodePlanAgentOptions {
  configDir?: string;
  templateDir?: string;
  tempRoot?: string;
}

export class OpencodePlanAgentConfigError extends Error {
  public readonly code: "INVALID_MODEL" | "INVALID_AGENT_FILE";

  public constructor(code: "INVALID_MODEL" | "INVALID_AGENT_FILE", message: string) {
    super(message);
    this.name = "OpencodePlanAgentConfigError";
    this.code = code;
  }
}

const AGENT_FILE_BY_ROLE: Record<OpencodePlanOcRole, string> = {
  planner: `${OPENCODE_PLAN_OC_AGENT}.md`,
  implementer: `${OPENCODE_IMPLEMENT_OC_AGENT}.md`
};

let mutationQueue: Promise<void> = Promise.resolve();

function withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function resolveOpencodePlanConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(xdgConfigHome, "actuarius-opencode");
}

function resolveTemplateDir(): string {
  return fileURLToPath(new URL("../../config/opencode-plan-oc/", import.meta.url));
}

function getPaths(options: OpencodePlanAgentOptions): {
  configDir: string;
  templateDir: string;
  agentsDir: string;
  templateAgentsDir: string;
} {
  const configDir = options.configDir ?? resolveOpencodePlanConfigDir();
  const templateDir = options.templateDir ?? resolveTemplateDir();
  return {
    configDir,
    templateDir,
    agentsDir: join(configDir, "agents"),
    templateAgentsDir: join(templateDir, "agents")
  };
}

async function writeFileIfMissing(target: string, content: string): Promise<void> {
  try {
    await writeFile(target, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

async function ensureFilesUnlocked(options: OpencodePlanAgentOptions): Promise<void> {
  const paths = getPaths(options);
  await mkdir(paths.agentsDir, { recursive: true });

  const configTemplate = await readFile(join(paths.templateDir, "opencode.json"), "utf8");
  await writeFileIfMissing(join(paths.configDir, "opencode.json"), configTemplate);

  for (const fileName of Object.values(AGENT_FILE_BY_ROLE)) {
    const template = await readFile(join(paths.templateAgentsDir, fileName), "utf8");
    await writeFileIfMissing(join(paths.agentsDir, fileName), template);
  }
}

function extractFrontmatter(content: string, filePath: string): { bodyStart: number; frontmatter: string } {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    throw new OpencodePlanAgentConfigError(
      "INVALID_AGENT_FILE",
      `Managed OpenCode agent file is missing YAML frontmatter: ${filePath}`
    );
  }

  const boundary = /\r?\n---\r?\n/u.exec(content.slice(3));
  if (!boundary || boundary.index === undefined) {
    throw new OpencodePlanAgentConfigError(
      "INVALID_AGENT_FILE",
      `Managed OpenCode agent file has unterminated YAML frontmatter: ${filePath}`
    );
  }

  const frontmatterStart = content.indexOf("\n") + 1;
  const boundaryStart = boundary.index + 3;
  return {
    bodyStart: boundaryStart,
    frontmatter: content.slice(frontmatterStart, boundaryStart)
  };
}

function extractModel(content: string, filePath: string): string | null {
  const { frontmatter } = extractFrontmatter(content, filePath);
  const match = /^model:\s*["']?([^\s"']+)["']?\s*$/mu.exec(frontmatter);
  return match?.[1] ?? null;
}

function assertAgentMode(
  content: string,
  filePath: string,
  expectedMode: "primary" | "subagent"
): void {
  const { frontmatter } = extractFrontmatter(content, filePath);
  const modes = [...frontmatter.matchAll(/^mode:\s*([A-Za-z-]+)\s*$/gmu)].map((match) => match[1]);
  if (modes.length !== 1 || modes[0] !== expectedMode) {
    throw new OpencodePlanAgentConfigError(
      "INVALID_AGENT_FILE",
      `Managed OpenCode agent file must declare exactly one \`mode: ${expectedMode}\`: ${filePath}`
    );
  }
}

function assertValidModel(model: string): void {
  if (model.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u.test(model)) {
    throw new OpencodePlanAgentConfigError(
      "INVALID_MODEL",
      "OpenCode model must use `provider/model-id` format and contain no whitespace."
    );
  }
}

function replaceModel(content: string, filePath: string, model: string | null): string {
  const { bodyStart, frontmatter } = extractFrontmatter(content, filePath);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const modelLine = /^model:[^\r\n]*(?:\r?\n)?/mu;
  let updatedFrontmatter: string;

  if (modelLine.test(frontmatter)) {
    updatedFrontmatter = frontmatter.replace(modelLine, model ? `model: ${model}${newline}` : "");
  } else if (model) {
    const modeLine = /^mode:[^\r\n]*(?:\r?\n)?/mu;
    if (!modeLine.test(frontmatter)) {
      throw new OpencodePlanAgentConfigError(
        "INVALID_AGENT_FILE",
        `Managed OpenCode agent file is missing its mode: ${filePath}`
      );
    }
    updatedFrontmatter = frontmatter.replace(
      modeLine,
      (line) => `${line.replace(/\r?\n$/u, "")}${newline}model: ${model}${newline}`
    );
  } else {
    return content;
  }

  return `${content.slice(0, content.indexOf("\n") + 1)}${updatedFrontmatter}${content.slice(bodyStart)}`;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const fileName = filePath.split(/[\\/]/u).pop() ?? "agent";
  const temporaryPath = join(dirname(filePath), `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readModels(configDir: string): Promise<OpencodePlanAgentModels> {
  const agentsDir = join(configDir, "agents");
  const plannerPath = join(agentsDir, AGENT_FILE_BY_ROLE.planner);
  const implementerPath = join(agentsDir, AGENT_FILE_BY_ROLE.implementer);
  const [planner, implementer] = await Promise.all([
    readFile(plannerPath, "utf8"),
    readFile(implementerPath, "utf8")
  ]);
  assertAgentMode(planner, plannerPath, "primary");
  assertAgentMode(implementer, implementerPath, "subagent");
  return {
    planner: extractModel(planner, plannerPath),
    implementer: extractModel(implementer, implementerPath)
  };
}

export async function ensureOpencodePlanAgentFiles(
  options: OpencodePlanAgentOptions = {}
): Promise<OpencodePlanAgentState> {
  return withMutationLock(async () => {
    await ensureFilesUnlocked(options);
    const configDir = getPaths(options).configDir;
    return { configDir, models: await readModels(configDir) };
  });
}

export async function setOpencodePlanAgentModel(
  role: OpencodePlanOcRole,
  model: string | null,
  options: OpencodePlanAgentOptions = {}
): Promise<OpencodePlanAgentState> {
  if (model !== null) {
    assertValidModel(model);
  }

  return withMutationLock(async () => {
    await ensureFilesUnlocked(options);
    const paths = getPaths(options);
    const filePath = join(paths.agentsDir, AGENT_FILE_BY_ROLE[role]);
    const content = await readFile(filePath, "utf8");
    const updated = replaceModel(content, filePath, model);
    if (updated !== content) {
      await atomicWrite(filePath, updated);
    }
    return { configDir: paths.configDir, models: await readModels(paths.configDir) };
  });
}

export async function createOpencodePlanAgentSnapshot(
  options: OpencodePlanAgentOptions = {}
): Promise<OpencodePlanAgentSnapshot> {
  return withMutationLock(async () => {
    // Hold the same lock used by model updates until every managed file has
    // been copied. Otherwise planner and implementer files could come from
    // different revisions when `/model-select-oc` races a queued request.
    await ensureFilesUnlocked(options);
    const managedConfigDir = getPaths(options).configDir;
    const snapshotDir = await mkdtemp(join(options.tempRoot ?? tmpdir(), "actuarius-opencode-plan-"));
    const snapshotAgentsDir = join(snapshotDir, "agents");
    await mkdir(snapshotAgentsDir, { recursive: true });

    try {
      await copyFile(join(managedConfigDir, "opencode.json"), join(snapshotDir, "opencode.json"));
      for (const fileName of Object.values(AGENT_FILE_BY_ROLE)) {
        await copyFile(join(managedConfigDir, "agents", fileName), join(snapshotAgentsDir, fileName));
      }
      await access(join(snapshotAgentsDir, AGENT_FILE_BY_ROLE.planner), constants.R_OK);
      await access(join(snapshotAgentsDir, AGENT_FILE_BY_ROLE.implementer), constants.R_OK);
      return {
        configDir: snapshotDir,
        models: await readModels(snapshotDir),
        cleanup: async () => {
          await rm(snapshotDir, { recursive: true, force: true });
        }
      };
    } catch (error) {
      await rm(snapshotDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}
