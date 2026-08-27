import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// Behavioral tests for the metadata-isolation engine that infra/startup.sh
// installs as /etc/actuarius/metadata-firewall-bootstrap.sh (security review
// finding C-1). The engine body is extracted verbatim from the heredoc and
// executed under bash with iptables/systemctl/sleep replaced by stateful
// mocks via BASH_ENV, reproducing production invocation semantics
// (`set -euo pipefail`, `harden_metadata_access || exit 1`).
//
// The mock emulates iptables behaviorally: -C membership, -nL listings with
// row numbers and a target column, positional -I/-R, and multi-copy -D. The
// engine under test deliberately avoids -S text comparison, so the mock
// never has to fake serialization.

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, "infra", "startup.sh");

const METADATA_IP = "169.254.169.254";
const GEN_A = "ACTUARIUS-META-A";
const GEN_B = "ACTUARIUS-META-B";
const TCP_RETURN_RULE = `-p tcp -d ${METADATA_IP}/32 --dport 53 -j RETURN`;
const UDP_RETURN_RULE = `-p udp -d ${METADATA_IP}/32 --dport 53 -j RETURN`;
const DROP_RULE = `-d ${METADATA_IP}/32 -j DROP`;
const EXPECTED_CHAIN = [TCP_RETURN_RULE, UDP_RETURN_RULE, DROP_RULE];
const JUMP_A = `-j ${GEN_A}`;
const JUMP_B = `-j ${GEN_B}`;
const LEGACY_DROP = `-d ${METADATA_IP}/32 -j DROP`;
const LEGACY_UDP_ACCEPT = `-p udp -d ${METADATA_IP}/32 --dport 53 -j ACCEPT`;
const LEGACY_TCP_ACCEPT = `-p tcp -d ${METADATA_IP}/32 --dport 53 -j ACCEPT`;
const BROAD_ACCEPT_RULE = `-d ${METADATA_IP}/32 -j ACCEPT`;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function toBashPath(path: string): string {
  if (process.platform !== "win32") return path;
  const normalized = path.replaceAll("\\", "/");
  return normalized.replace(/^([A-Za-z]):/u, (_match, drive: string) => `/${drive.toLowerCase()}`);
}

function extractEngine(): string {
  const lines = readFileSync(scriptPath, { encoding: "utf8" }).split(/\r?\n/u);
  const start = lines.findIndex((line) => line.includes("<<'METADATA_FIREWALL_EOF'"));
  const end = lines.findIndex((line) => line.trim() === "METADATA_FIREWALL_EOF");
  expect(start, "bootstrap heredoc start not found").toBeGreaterThanOrEqual(0);
  expect(end, "bootstrap heredoc end not found").toBeGreaterThan(start);
  const body = lines.slice(start + 1, end).join("\n");
  expect(body).toContain("harden_metadata_access() {");
  expect(body).toContain("content_ok() {");
  // The self-invocation guard is appended by a separate heredoc; the harness
  // provides its own invocation.
  expect(body.endsWith("}")).toBe(true);
  return body;
}

type RunResult = {
  status: number | null;
  stderr: string;
};

type FailureInjection = {
  flush?: boolean;
  appendTcp?: boolean;
  appendUdp?: boolean;
  appendDrop?: boolean;
  jumpInsert?: boolean;
  jumpReplace?: boolean;
  legacyDelete?: boolean;
  strayPurge?: boolean;
  // Silently append an extra rule right after the DROP rule lands, forcing
  // post-repair verification to fail.
  corruptAfterPopulate?: boolean;
};

type MockState = {
  chain: "up" | "down";
  chainReadyAfterProbes?: number;
  forwardJump: "up" | "down";
  forwardRules?: string[];
  dockerUserRules?: string[];
  genARules?: string[];
  genBRules?: string[];
  failures?: FailureInjection;
};

function runFirewall(state: MockState): RunResult & {
  mutations: string[];
  dockerUser: string[];
  genA: string[];
  genB: string[];
  sleeps: number;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "startup-firewall-test-"));
  tempDirs.push(tempDir);

  const binStatePath = join(tempDir, "state.env");
  const mutationsPath = join(tempDir, "iptables-mutations.log");
  const duPath = join(tempDir, "docker-user.rules");
  const forwardPath = join(tempDir, "forward.rules");
  const genAPath = join(tempDir, "gen-a.rules");
  const genBPath = join(tempDir, "gen-b.rules");
  const sleepsPath = join(tempDir, "sleeps.log");

  const failures = state.failures ?? {};
  writeFileSync(binStatePath, [
    `CHAIN_STATE=${state.chain === "up" ? 1 : 0}`,
    `CHAIN_READY_AFTER_PROBES=${state.chainReadyAfterProbes ?? 0}`,
    `FAIL_FLUSH=${failures.flush ? 1 : 0}`,
    `FAIL_APPEND_TCP=${failures.appendTcp ? 1 : 0}`,
    `FAIL_APPEND_UDP=${failures.appendUdp ? 1 : 0}`,
    `FAIL_APPEND_DROP=${failures.appendDrop ? 1 : 0}`,
    `FAIL_JUMP_INSERT=${failures.jumpInsert ? 1 : 0}`,
    `FAIL_JUMP_REPLACE=${failures.jumpReplace ? 1 : 0}`,
    `FAIL_LEGACY_DELETE=${failures.legacyDelete ? 1 : 0}`,
    `FAIL_STRAY_PURGE=${failures.strayPurge ? 1 : 0}`,
    `CORRUPT_AFTER_POPULATE=${failures.corruptAfterPopulate ? 1 : 0}`,
    `GEN_A=${GEN_A}`,
    `GEN_B=${GEN_B}`,
    `LEGACY_DROP_SPEC='${LEGACY_DROP}'`,
    `JUMP_A_SPEC='${JUMP_A}'`,
    `JUMP_B_SPEC='${JUMP_B}'`,
    `DU_RULES_FILE=${toBashPath(duPath)}`,
    `FORWARD_RULES_FILE=${toBashPath(forwardPath)}`,
    `GEN_A_FILE=${toBashPath(genAPath)}`,
    `GEN_B_FILE=${toBashPath(genBPath)}`,
    `MUTATIONS_FILE=${toBashPath(mutationsPath)}`,
    `SLEEPS_FILE=${toBashPath(sleepsPath)}`,
    "",
  ].join("\n"));
  if (state.dockerUserRules?.length) {
    writeFileSync(duPath, `${state.dockerUserRules.join("\n")}\n`);
  }
  const forwardRules = state.forwardRules
    ?? (state.forwardJump === "up" ? ["-j DOCKER-USER"] : []);
  if (forwardRules.length) {
    writeFileSync(forwardPath, `${forwardRules.join("\n")}\n`);
  }
  if (state.genARules?.length) {
    writeFileSync(genAPath, `${state.genARules.join("\n")}\n`);
  }
  if (state.genBRules?.length) {
    writeFileSync(genBPath, `${state.genBRules.join("\n")}\n`);
  }

  const mockFunctions = [
    `source ${toBashPath(binStatePath)} || exit 99`,
    "probe_count=$CHAIN_READY_AFTER_PROBES",
    "rules_file_for() {",
    '  case "$1" in',
    '    DOCKER-USER) printf \'%s\' "$DU_RULES_FILE" ;;',
    '    "$GEN_A") printf \'%s\' "$GEN_A_FILE" ;;',
    '    "$GEN_B") printf \'%s\' "$GEN_B_FILE" ;;',
    '    *) return 2 ;;',
    "  esac",
    "}",
    "systemctl() {",
    '  if [ "$1" = "is-active" ]; then',
    '    if [ "$CHAIN_STATE" = 1 ]; then return 0; fi',
    "    return 1",
    "  fi",
    "  return 0",
    "}",
    // Emit an -nL-style listing: two header rows, then numbered data rows
    // whose second column is the rule's target. This is what the engine's
    // LC_ALL=C parsing relies on.
    "emit_listing() {",
    '  local f="$1" chain="$2" n=0 line tgt',
    '  printf \'Chain %s (policy ACCEPT)\\n\' "$chain"',
    '  printf \'target     prot opt source               destination\\n\'',
    '  [ -f "$f" ] || return 0',
    '  while IFS= read -r line; do',
    '    [ -n "$line" ] || continue',
    "    n=$((n + 1))",
    '    # Reproduce real -nL behavior: CONDITIONAL jumps still report their',
    '    # target chain in the target column. The engine must therefore not',
    '    # rely on that column alone.',
    '    case "$line" in',
    '      "-j "*) tgt="${line#-j }" ;;',
    '      *"-j "*) tgt="${line##*-j }" ;;',
    '      *) tgt="UNKNOWN" ;;',
    "    esac",
    '    printf \'%d %s prot opt 0.0.0.0/0 0.0.0.0/0\\n\' "$n" "$tgt"',
    '  done < "$f"',
    "}",
    "iptables() {",
    '  # The script passes bare "-w" (no timeout argument); eat exactly it.',
    '  if [ "${1:-}" = "-w" ]; then shift 1; fi',
    '  local op="$1"',
    '  local chain="${2:-}"',
    '  case "$op" in',
    "    -nL)",
    '      if [ "$chain" = "DOCKER-USER" ]; then',
    '        if [ "$CHAIN_STATE" = 1 ] && [ "$probe_count" -le 0 ]; then',
    '          emit_listing "$DU_RULES_FILE" "$chain"',
    "          return 0",
    "        fi",
    "        probe_count=$((probe_count - 1))",
    "        return 2",
    "      fi",
    '      local f; f="$(rules_file_for "$chain")" || return 2',
    '      [ -f "$f" ] || return 2',
    '      emit_listing "$f" "$chain"',
    "      return 0 ;;",
    "    -S)",
    '      if [ "$chain" = "FORWARD" ]; then',
    '        [ -f "$FORWARD_RULES_FILE" ] && sed "s/^/-A FORWARD /" "$FORWARD_RULES_FILE"',
    '        [ -s "$FORWARD_RULES_FILE" ] || printf -- \'-P FORWARD ACCEPT\\n\'',
    "        return 0",
    "      fi",
    '      if [ "$chain" = "DOCKER-USER" ]; then',
    '        [ -f "$DU_RULES_FILE" ] && sed "s/^/-A DOCKER-USER /" "$DU_RULES_FILE"',
    "        return 0",
    "      fi",
    '      echo "unexpected -S use: $*" >&2',
    "      return 64 ;;",
    "    -N)",
    '      local f; f="$(rules_file_for "$chain")" || return 2',
    '      [ -f "$f" ] || : > "$f"',
    "      return 0 ;;",
    "    -F)",
    '      if [ "$FAIL_FLUSH" = 1 ]; then return 1; fi',
    '      local f; f="$(rules_file_for "$chain")" || return 2',
    '      : > "$f"',
    '      printf \'%s\\n\' "-F $chain" >> "$MUTATIONS_FILE"',
    "      return 0 ;;",
    "    -A)",
    "      shift 2",
    '      local f; f="$(rules_file_for "$chain")" || return 2',
    '      if [ "$FAIL_APPEND_TCP" = 1 ] && printf \'%s\' "$*" | grep -q -- "-p tcp"; then return 1; fi',
    '      if [ "$FAIL_APPEND_UDP" = 1 ] && printf \'%s\' "$*" | grep -q -- "-p udp"; then return 1; fi',
    '      if [ "$FAIL_APPEND_DROP" = 1 ] && printf \'%s\' "$*" | grep -q -- "-j DROP"; then return 1; fi',
    '      printf \'%s\\n\' "$*" >> "$f"',
    '      printf \'%s\\n\' "-A $*" >> "$MUTATIONS_FILE"',
    '      if [ "$CORRUPT_AFTER_POPULATE" = 1 ] && printf \'%s\' "$*" | grep -q -- "-j DROP"; then',
    '        printf \'%s\\n\' "-p sctp -j ACCEPT" >> "$f"',
    "      fi",
    "      return 0 ;;",
    "    -C)",
    "      shift 2",
    '      grep -Fxq -- "$*" "$(rules_file_for "$chain")" 2>/dev/null',
    "      return $? ;;",
    "    -I)",
    '      if [ "$chain" != "DOCKER-USER" ]; then return 64; fi',
    "      shift 3 # -I <chain> <position>",
    '      if [ "$FAIL_JUMP_INSERT" = 1 ]; then return 1; fi',
    '      local f; f="$DU_RULES_FILE"',
    '      { printf \'%s\\n\' "$*"; cat "$f" 2>/dev/null || true; } > "$f.tmp" && mv "$f.tmp" "$f"',
    '      printf \'%s\\n\' "-I $*" >> "$MUTATIONS_FILE"',
    "      return 0 ;;",
    "    -R)",
    '      if [ "$chain" != "DOCKER-USER" ]; then return 64; fi',
    "      shift 3 # -R <chain> <position>",
    '      if [ "$FAIL_JUMP_REPLACE" = 1 ]; then return 1; fi',
    '      local f; f="$DU_RULES_FILE"',
    '      { printf \'%s\\n\' "$*"; tail -n +2 "$f" 2>/dev/null || true; } > "$f.tmp" && mv "$f.tmp" "$f"',
    '      printf \'%s\\n\' "-R $*" >> "$MUTATIONS_FILE"',
    "      return 0 ;;",
    "    -D)",
    "      shift 2",
    '      local f; f="$(rules_file_for "$chain")" || return 2',
    '      if ! grep -Fxq -- "$*" "$f" 2>/dev/null; then return 1; fi',
    '      if [ "$FAIL_LEGACY_DELETE" = 1 ] && [ "$*" = "$LEGACY_DROP_SPEC" ]; then return 1; fi',
    '      if [ "$FAIL_STRAY_PURGE" = 1 ] && { [ "$*" = "$JUMP_A_SPEC" ] || [ "$*" = "$JUMP_B_SPEC" ]; }; then return 1; fi',
    '      printf \'%s\\n\' "-D $*" >> "$MUTATIONS_FILE"',
    '      grep -Fvx -- "$*" "$f" > "$f.tmp"; mv "$f.tmp" "$f"',
    "      return 0 ;;",
    "  esac",
    '  echo "unexpected iptables call: $*" >&2',
    "  return 64",
    "}",
    "sleep() {",
    '  printf \'sleep\\n\' >> "$SLEEPS_FILE"',
    "}",
    "",
  ].join("\n");

  const bashEnvPath = join(tempDir, "bash-env.sh");
  writeFileSync(bashEnvPath, mockFunctions);

  const harnessPath = join(tempDir, "harness.sh");
  writeFileSync(harnessPath, [
    "set -euo pipefail",
    extractEngine(),
    "harden_metadata_access || exit 1",
    "",
  ].join("\n"));

  const bashExecutable = process.platform === "win32"
    ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
    : "bash";
  const result = spawnSync(bashExecutable, [toBashPath(harnessPath)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BASH_ENV: toBashPath(bashEnvPath),
    },
    encoding: "utf8",
  });

  const readLines = (path: string): string[] =>
    readFileSync(path, { encoding: "utf8", flag: "a+" })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  return {
    status: result.status,
    stderr: result.stderr,
    mutations: readLines(mutationsPath),
    dockerUser: readLines(duPath),
    genA: readLines(genAPath),
    genB: readLines(genBPath),
    sleeps: readLines(sleepsPath).length,
  };
}

describe("infra/startup.sh metadata isolation engine", () => {
  it("makes zero mutations when the active generation already satisfies policy", () => {
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      dockerUserRules: [JUMP_A],
      genARules: EXPECTED_CHAIN,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.mutations).toEqual([]);
    expect(result.dockerUser).toEqual([JUMP_A]);
    expect(result.genA).toEqual(EXPECTED_CHAIN);
    expect(result.genB).toEqual([]);
  });

  it("installs generation A and the jump from scratch on a fresh host", () => {
    const result = runFirewall({ chain: "up", forwardJump: "up" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.mutations).toEqual([
      `-F ${GEN_A}`,
      `-A ${TCP_RETURN_RULE}`,
      `-A ${UDP_RETURN_RULE}`,
      `-A ${DROP_RULE}`,
      `-I ${JUMP_A}`,
    ]);
    expect(result.dockerUser).toEqual([JUMP_A]);
    expect(result.genA).toEqual(EXPECTED_CHAIN);
  });

  it("repairs into the unreferenced generation and flips atomically", () => {
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      dockerUserRules: [JUMP_A],
      genARules: [...EXPECTED_CHAIN, "-p sctp -j ACCEPT"],
    });

    expect(result.status, result.stderr).toBe(0);
    // Build B fully (detached), THEN flip atomically (-R replaces the old
    // jump, leaving nothing to purge), THEN retire A. The live chain is
    // never flushed while referenced.
    expect(result.mutations).toEqual([
      `-F ${GEN_B}`,
      `-A ${TCP_RETURN_RULE}`,
      `-A ${UDP_RETURN_RULE}`,
      `-A ${DROP_RULE}`,
      `-R ${JUMP_B}`,
      `-F ${GEN_A}`,
    ]);
    expect(result.dockerUser).toEqual([JUMP_B]);
    expect(result.genB).toEqual(EXPECTED_CHAIN);
    expect(result.genA).toEqual([]);
  });

  it("alternates generations when drift recurs on the newly active generation", () => {
    const second = runFirewall({
      chain: "up",
      forwardJump: "up",
      dockerUserRules: [JUMP_B],
      genBRules: [...EXPECTED_CHAIN, "-p sctp -j ACCEPT"],
      genARules: [],
    });
    expect(second.status, second.stderr).toBe(0);
    expect(second.mutations).toEqual([
      `-F ${GEN_A}`,
      `-A ${TCP_RETURN_RULE}`,
      `-A ${UDP_RETURN_RULE}`,
      `-A ${DROP_RULE}`,
      `-R ${JUMP_A}`,
      `-F ${GEN_B}`,
    ]);
    expect(second.dockerUser).toEqual([JUMP_A]);
    expect(second.genA).toEqual(EXPECTED_CHAIN);
    expect(second.genB).toEqual([]);
  });

  it("treats a broad metadata ACCEPT above the jump as drift and repairs above it", () => {
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      dockerUserRules: [BROAD_ACCEPT_RULE, JUMP_A],
      genARules: EXPECTED_CHAIN,
    });

    expect(result.status, result.stderr).toBe(0);
    // A remains attached while B is built. Only after B is inserted at rule
    // 1 is the old A jump retired, so repair introduces no new exposure gap.
    expect(result.mutations).toEqual([
      `-F ${GEN_B}`,
      `-A ${TCP_RETURN_RULE}`,
      `-A ${UDP_RETURN_RULE}`,
      `-A ${DROP_RULE}`,
      `-I ${JUMP_B}`,
      `-D ${JUMP_A}`,
      `-F ${GEN_A}`,
    ]);
    expect(result.dockerUser).toEqual([JUMP_B, BROAD_ACCEPT_RULE]);
  });

  it("keeps a later managed jump attached when replacement population fails", () => {
    const harmlessPrefix = "-p icmp -j ACCEPT";
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      dockerUserRules: [harmlessPrefix, JUMP_A],
      genARules: EXPECTED_CHAIN,
      failures: { appendDrop: true },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not build");
    expect(result.dockerUser).toEqual([harmlessPrefix, JUMP_A]);
  });

  it("tolerates a broad metadata ACCEPT shadowed below the jump", () => {
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      dockerUserRules: [JUMP_A, BROAD_ACCEPT_RULE],
      genARules: EXPECTED_CHAIN,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.mutations).toEqual([]);
  });

  it.each([
    ["protocol-conditioned", "-p tcp -j ACTUARIUS-META-A"],
    ["source-conditioned", `-s 10.88.0.0/16 -j ${GEN_A}`],
    ["destination-conditioned", `-d ${METADATA_IP}/32 -j ${GEN_A}`],
    ["interface-conditioned", `-i eth0 -j ${GEN_A}`],
  ])("rejects a %s first rule as conditional drift and repairs above it", (_label, conditionalRule) => {
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      dockerUserRules: [conditionalRule],
      genARules: EXPECTED_CHAIN,
    });

    // The -nL target column reports GEN_A for conditional jumps, so only
    // the exact unconditional-jump check can catch this.
    expect(result.status, result.stderr).toBe(0);
    expect(result.mutations).toEqual([
      `-F ${GEN_B}`,
      `-A ${TCP_RETURN_RULE}`,
      `-A ${UDP_RETURN_RULE}`,
      `-A ${DROP_RULE}`,
      `-R ${JUMP_B}`,
      `-F ${GEN_A}`,
    ]);
    expect(result.dockerUser).toEqual([JUMP_B]);
    expect(result.genB).toEqual(EXPECTED_CHAIN);
  });

  it("purges surviving legacy rules because their absence is load-bearing for DNS", () => {
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      dockerUserRules: [JUMP_A, LEGACY_DROP, LEGACY_TCP_ACCEPT, LEGACY_UDP_ACCEPT],
      genARules: EXPECTED_CHAIN,
    });

    expect(result.status, result.stderr).toBe(0);
    // Any drift — legacy presence included — triggers a full repair into the
    // other generation.
    expect(result.mutations.filter((entry) => entry.startsWith("-D"))).toEqual([
      `-D ${LEGACY_DROP}`,
      `-D ${LEGACY_UDP_ACCEPT}`,
      `-D ${LEGACY_TCP_ACCEPT}`,
    ]);
    expect(result.dockerUser).toEqual([JUMP_B]);
  });

  it("fails closed when a legacy DROP cannot be removed", () => {
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      dockerUserRules: [JUMP_A, LEGACY_DROP],
      genARules: EXPECTED_CHAIN,
      failures: { legacyDelete: true },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("legacy");
  });

  it("fails closed when a stray jump to the other generation cannot be detached", () => {
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      dockerUserRules: [JUMP_A, JUMP_B],
      genARules: EXPECTED_CHAIN,
      failures: { strayPurge: true },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot detach");
  });

  it("retires a stray jump below the active one during repair", () => {
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      dockerUserRules: [JUMP_A, JUMP_B],
      genARules: EXPECTED_CHAIN,
    });

    expect(result.status, result.stderr).toBe(0);
    // Pre-flip detach purges the stray B jump (both copies in the mock),
    // B is rebuilt detached, the jump flips to B, A is retired.
    expect(result.mutations).toEqual([
      `-D ${JUMP_B}`,
      `-F ${GEN_B}`,
      `-A ${TCP_RETURN_RULE}`,
      `-A ${UDP_RETURN_RULE}`,
      `-A ${DROP_RULE}`,
      `-R ${JUMP_B}`,
      `-F ${GEN_A}`,
    ]);
    expect(result.dockerUser).toEqual([JUMP_B]);
  });

  it("fails closed when building the replacement generation fails", () => {
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      dockerUserRules: [JUMP_A],
      genARules: [...EXPECTED_CHAIN, "-p sctp -j ACCEPT"],
      failures: { appendDrop: true },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not build");
    // The live jump was untouched.
    expect(result.dockerUser).toEqual([JUMP_A]);
  });

  it("fails closed when flushing the replacement generation fails", () => {
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      failures: { flush: true },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not build");
  });

  it("fails closed when the atomic jump switch fails", () => {
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      dockerUserRules: [JUMP_A],
      genARules: [...EXPECTED_CHAIN, "-p sctp -j ACCEPT"],
      failures: { jumpReplace: true },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not switch");
    expect(result.dockerUser).toEqual([JUMP_A]);
  });

  it("fails closed when installing the first jump fails", () => {
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      failures: { jumpInsert: true },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not install");
  });

  it("fails closed when post-repair verification detects corruption", () => {
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      dockerUserRules: [JUMP_A],
      genARules: [...EXPECTED_CHAIN, "-p sctp -j ACCEPT"],
      failures: { corruptAfterPopulate: true },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("post-repair verification");
  });

  it("fails closed when docker never becomes ready", () => {
    const result = runFirewall({ chain: "down", forwardJump: "up" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not ready in time");
  });

  it("fails closed when DOCKER-USER is not jumped from FORWARD", () => {
    const result = runFirewall({ chain: "up", forwardJump: "down" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not ready in time");
  });

  it.each([
    ["conditional", ["-p tcp -j DOCKER-USER"]],
    ["shadowed", ["-j ACCEPT", "-j DOCKER-USER"]],
  ])("fails closed when the FORWARD jump is %s", (_label, forwardRules) => {
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      forwardRules,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not ready in time");
  });

  it("retries until the chains appear instead of giving up immediately", () => {
    const result = runFirewall({
      chain: "up",
      forwardJump: "up",
      chainReadyAfterProbes: 5,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.sleeps).toBeGreaterThanOrEqual(5);
    expect(result.dockerUser).toEqual([JUMP_A]);
    expect(result.genA).toEqual(EXPECTED_CHAIN);
  });
});

describe("boot-path enforcement wiring", () => {
  const scriptText = (): string =>
    readFileSync(scriptPath, { encoding: "utf8" });

  it("keeps the bootstrap invocation fail-closed and ahead of the redeploy step", () => {
    const lines = scriptText().split(/\r?\n/u);
    const invocation = lines.findIndex((line) => line.trim() === 'bash "$BOOTSTRAP"');
    const redeployInstall = lines.findIndex((line) => line.includes("--- Install redeploy helper script"));

    expect(invocation).toBeGreaterThan(0);
    expect(redeployInstall).toBeGreaterThan(invocation);
    expect(scriptText()).toContain("harden_metadata_access || exit 1");
  });

  it("verifies semantics instead of serialization spelling", () => {
    const text = scriptText();
    expect(text).toContain("LC_ALL=C iptables -w -nL");
    expect(text).toContain('iptables -w -C "$gen" $spec');
    expect(text).toContain('iptables -w -C DOCKER-USER $spec');
    // -S appears only for exact first-jump checks and for round-tripping a
    // canonical managed-jump rule during deletion.
    const sUses = text.split(/\r?\n/u)
      .filter((line) => !line.trimStart().startsWith("#") && line.includes("iptables -S "));
    expect(sUses).toHaveLength(3);
    expect(sUses.filter((line) => line.includes("-S FORWARD"))).toHaveLength(1);
    expect(sUses.filter((line) => line.includes("-S DOCKER-USER"))).toHaveLength(2);
    expect(text).toContain("jump_is_unconditional_first");
  });

  it("documents the stateless-/etc boot reality", () => {
    const text = scriptText();
    expect(text).toContain("STATELESS");
    expect(text).toContain("scripts/cutover-metadata-isolation.sh");
    // Units are (re)written unconditionally on every boot before enablement.
    expect(text.indexOf(`cat > "$FIREWALL_UNIT"`)).toBeGreaterThan(-1);
    expect(text.indexOf("systemctl daemon-reload")).toBeGreaterThan(
      text.indexOf(`cat > "$BOT_UNIT"`)
    );
  });

  it("orders systemd so the container cannot start before isolation", () => {
    const text = scriptText();

    expect(text).toContain("Requires=docker.service");
    expect(text).toContain("Before=actuarius-bot.service");
    expect(text).toContain('ExecStart=/bin/bash ${BOOTSTRAP}');
    expect(text).not.toContain("ExecStart=/usr/bin/bash");
    expect(text).toContain("Requires=docker.service actuarius-firewall.service");
    expect(text).toContain("After=docker.service actuarius-firewall.service");
    expect(text).toContain('ExecStartPre=/bin/bash ${BOOTSTRAP}');
    expect(text).toContain("ExecStart=/usr/bin/docker start -a actuarius");
    expect(text.indexOf("ExecStart=/usr/bin/docker start -a actuarius")).toBeGreaterThan(
      text.indexOf('ExecStartPre=/bin/bash ${BOOTSTRAP}')
    );
    expect(text).toContain("Restart=always");
    expect(text).toContain("systemctl enable actuarius-firewall.service actuarius-bot.service");
    expect(text).toContain("systemctl daemon-reload");
  });
});

describe("first-rollout cutover tooling", () => {
  const cutoverPath = join(repoRoot, "scripts", "cutover-metadata-isolation.sh");

  const OLD_STARTUP_PAYLOAD = [
    "#!/bin/bash",
    "curl -sf -H 'Metadata-Flavor: Google' \"$META/env-redeploy-script\" > /var/redeploy.sh",
    "bash /var/redeploy.sh",
    "",
  ].join("\n");
  const OLD_REDEPLOY_PAYLOAD = [
    "docker run -d --name actuarius --restart unless-stopped \\",
    "",
  ].join("\n");
  // Real repo bytes: compute.tf publishes these exact files as metadata
  // payloads, and the cutover script's embedded hashes are computed over
  // them. A pristine fetch therefore matches by construction.
  const NEW_STARTUP_PAYLOAD = readFileSync(join(repoRoot, "infra", "startup.sh"), { encoding: "utf8" });
  const NEW_REDEPLOY_PAYLOAD = readFileSync(join(repoRoot, "scripts", "redeploy.sh"), { encoding: "utf8" });

  type MetadataMode = "ok" | "http_fail" | "missing_startup" | "missing_redeploy" | "old_startup" | "old_redeploy";

  type CutoverState = {
    daemonUp?: boolean;
    containerExists?: boolean;
    // Generic (non no-such-object) inspect failure instead of success.
    containerInspectError?: boolean;
    policy?: "unless-stopped" | "no";
    running?: "true" | "false";
    updateFails?: boolean;
    stopFails?: boolean;
    // Every inspect after the first successful update fails generically.
    inspectFailAfterUpdate?: boolean;
    metadataMode?: MetadataMode;
    // Serve payloads whose bytes deviate from the reviewed release while
    // still containing every structural marker — a known-vulnerable prior
    // revision must fail on hash comparison alone.
    staleMarkedPayload?: boolean;
  };

  function runCutover(state: CutoverState): RunResult & {
    stdout: string;
    dockerCalls: string[];
    curlCalls: string[];
    finalPolicy: string;
    finalRunning: string;
  } {
    const tempDir = mkdtempSync(join(tmpdir(), "cutover-test-"));
    tempDirs.push(tempDir);

    const binStatePath = join(tempDir, "state.env");
    const dockerLogPath = join(tempDir, "docker-calls.log");
    const curlLogPath = join(tempDir, "curl-calls.log");
    const policyPath = join(tempDir, "policy.txt");
    const runningPath = join(tempDir, "running.txt");
    const updateCountPath = join(tempDir, "update-count.txt");
    const startupPayloadPath = join(tempDir, "payload-startup.txt");
    const redeployPayloadPath = join(tempDir, "payload-redeploy.txt");
    // Serve REAL repo file bytes: the embedded EXPECTED_*_SHA256 constants
    // are computed over exactly these files (compute.tf publishes them via
    // file(...)), so a pristine fetch matches by construction. Env-supplied
    // hashes would be a security hole — the script's embedded constants are
    // authoritative and cannot be overridden.
    const mode = state.metadataMode ?? "ok";
    const startupPayload =
      state.staleMarkedPayload ? `${NEW_STARTUP_PAYLOAD}# stale revision\n`
        : mode === "old_startup" ? OLD_STARTUP_PAYLOAD
          : mode === "missing_startup" ? null
            : NEW_STARTUP_PAYLOAD;
    const redeployPayload =
      state.staleMarkedPayload ? `${NEW_REDEPLOY_PAYLOAD}# stale revision\n`
        : mode === "old_redeploy" ? OLD_REDEPLOY_PAYLOAD
          : mode === "missing_redeploy" ? null
            : NEW_REDEPLOY_PAYLOAD;
    writeFileSync(binStatePath, [
      `DOCKER_INFO_OK=${state.daemonUp === false ? 0 : 1}`,
      `CONTAINER_EXISTS=${state.containerExists === false ? 0 : 1}`,
      `CONTAINER_INSPECT_ERROR=${state.containerInspectError ? 1 : 0}`,
      `POLICY_FILE=${toBashPath(policyPath)}`,
      `RUNNING_FILE=${toBashPath(runningPath)}`,
      `UPDATE_COUNT_FILE=${toBashPath(updateCountPath)}`,
      `UPDATE_FAILS=${state.updateFails ? 1 : 0}`,
      `STOP_FAILS=${state.stopFails ? 1 : 0}`,
      `INSPECT_FAIL_AFTER_UPDATE=${state.inspectFailAfterUpdate ? 1 : 0}`,
      `METADATA_HTTP_FAILS=${mode === "http_fail" ? 1 : 0}`,
      `DOCKER_CALL_LOG=${toBashPath(dockerLogPath)}`,
      `CURL_CALL_LOG=${toBashPath(curlLogPath)}`,
      `STARTUP_PAYLOAD_FILE=${toBashPath(startupPayloadPath)}`,
      `REDEPLOY_PAYLOAD_FILE=${toBashPath(redeployPayloadPath)}`,
      `CONTAINER_NAME=actuarius`,
      "",
    ].join("\n"));
    writeFileSync(policyPath, state.policy ?? "unless-stopped");
    writeFileSync(runningPath, state.running ?? "true");
    if (mode !== "http_fail") {
      if (startupPayload !== null) {
        writeFileSync(startupPayloadPath, startupPayload);
      }
      if (redeployPayload !== null) {
        writeFileSync(redeployPayloadPath, redeployPayload);
      }
    }

    const mockFunctions = [
      `source ${toBashPath(binStatePath)} || exit 99`,
      'log_docker() { printf \'%s\\n\' "$*" >> "$DOCKER_CALL_LOG"; }',
      'log_curl() { printf \'%s\\n\' "$*" >> "$CURL_CALL_LOG"; }',
      "docker() {",
      "  log_docker \"$*\"",
      '  case "$1" in',
      "    info)",
      '      if [ "$DOCKER_INFO_OK" = 1 ]; then return 0; fi',
      '      echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2',
      "      return 1 ;;",
      "    update)",
      '      if [ "$UPDATE_FAILS" = 1 ]; then return 1; fi',
      '      printf \'no\' > "$POLICY_FILE"',
      '      printf \'%s\' "$(( $(cat "$UPDATE_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))" > "$UPDATE_COUNT_FILE"',
      "      echo actuarius",
      "      return 0 ;;",
      "    stop)",
      '      if [ "$STOP_FAILS" = 1 ]; then return 1; fi',
      '      printf \'false\' > "$RUNNING_FILE"',
      "      echo actuarius",
      "      return 0 ;;",
      "    inspect)",
      '      local fmt="" name=""',
      '      while [ "$#" -gt 0 ]; do',
      '        case "$1" in',
      '          -f) fmt="$2"; shift 2 ;;',
      '          *) name="$1"; shift ;;',
      "        esac",
      "      done",
      '      if [ "$CONTAINER_INSPECT_ERROR" = 1 ]; then echo "Error response from daemon: permission denied" >&2; return 1; fi',
      '      if [ "$CONTAINER_EXISTS" != 1 ]; then echo "Error: No such object: ${name:-$CONTAINER_NAME}" >&2; return 1; fi',
      '      if [ "${INSPECT_FAIL_AFTER_UPDATE:-0}" = 1 ] && [ "$(cat "$UPDATE_COUNT_FILE" 2>/dev/null || echo 0)" -ge 1 ]; then',
      '        echo "Error response from daemon: transport is closing" >&2',
      "        return 1",
      "      fi",
      '      case "$fmt" in',
      '        *RestartPolicy*) cat "$POLICY_FILE" ;;',
      '        *State.Running*) cat "$RUNNING_FILE" ;;',
      '        *) echo "full-inspect" ;;',
      "      esac",
      "      return 0 ;;",
      "  esac",
      '  echo "unexpected docker call: $*" >&2',
      "  return 64",
      "}",
      "curl() {",
      "  log_curl \"$*\"",
      '  if [ "$METADATA_HTTP_FAILS" = 1 ]; then echo "curl: (7) Failed to connect" >&2; return 7; fi',
      "  local url=\"\" out=\"\" prev=\"\" a",
      '  for a in "$@"; do',
      '    if [ "$prev" = "-o" ]; then out="$a";',
    '    elif [ "$a" = "-o" ]; then :;',
      '    elif [ "${a#-}" != "$a" ]; then :;',
      '    else url="$a"; fi',
      '    prev="$a"',
      "  done",
      '  [ -n "$url" ] || return 22',
      '  local src=""',
      '  case "$url" in',
      '    *env-startup-script) src="$STARTUP_PAYLOAD_FILE" ;;',
      '    *env-redeploy-script) src="$REDEPLOY_PAYLOAD_FILE" ;;',
      '    *) echo "unexpected metadata url: $url" >&2; return 22 ;;',
      "  esac",
      '  if [ ! -f "$src" ]; then echo "curl: (22) The requested URL returned error: 404" >&2; return 22; fi',
      '  cat "$src" > "${out:?missing -o target}"',
      "}",
      "",
    ].join("\n");

    const bashEnvPath = join(tempDir, "bash-env.sh");
    writeFileSync(bashEnvPath, mockFunctions);

    const bashExecutable = process.platform === "win32"
      ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
      : "bash";
    const result = spawnSync(bashExecutable, [toBashPath(cutoverPath)], {
      cwd: repoRoot,
      env: {
        ...process.env,
        BASH_ENV: toBashPath(bashEnvPath),
      },
      encoding: "utf8",
    });

    const readLines = (path: string): string[] =>
      readFileSync(path, { encoding: "utf8", flag: "a+" })
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.trimEnd());

    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
      dockerCalls: readLines(dockerLogPath),
      curlCalls: readLines(curlLogPath).map((entry) =>
        entry.includes("env-startup-script") ? "fetch env-startup-script"
          : entry.includes("env-redeploy-script") ? "fetch env-redeploy-script"
            : entry
      ),
      finalPolicy: readFileSync(policyPath, { encoding: "utf8", flag: "a+" }).trim(),
      finalRunning: readFileSync(runningPath, { encoding: "utf8", flag: "a+" }).trim(),
    };
  }

  it("migrates a legacy container end-to-end and only then prints the reboot instruction", () => {
    const result = runCutover({ policy: "unless-stopped", running: "true" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.dockerCalls).toEqual([
      "info",
      "inspect actuarius",
      "inspect -f {{.HostConfig.RestartPolicy.Name}} actuarius",
      "inspect -f {{.State.Running}} actuarius",
      "update --restart=no actuarius",
      "inspect -f {{.HostConfig.RestartPolicy.Name}} actuarius",
      "stop actuarius",
      "inspect -f {{.State.Running}} actuarius",
    ]);
    expect(result.curlCalls).toEqual(["fetch env-startup-script", "fetch env-redeploy-script"]);
    expect(result.finalPolicy).toBe("no");
    expect(result.finalRunning).toBe("false");
    expect(result.stdout).toContain("safe to reboot");
  });

  it("reports verified-safe for an absent container but only after health and metadata checks", () => {
    const result = runCutover({ containerExists: false, policy: "no", running: "false" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no 'actuarius' container exists");
    expect(result.dockerCalls).toEqual(["info", "inspect actuarius"]);
    expect(result.curlCalls).toEqual(["fetch env-startup-script", "fetch env-redeploy-script"]);
  });

  it("exits early as already-migrated without touching docker mutations", () => {
    const result = runCutover({ policy: "no", running: "false" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Already migrated");
    expect(result.dockerCalls.join("\n")).not.toContain("update");
    expect(result.dockerCalls.join("\n")).not.toContain("stop");
  });

  it("fails closed when the docker daemon is unreachable, before any metadata fetch", () => {
    const result = runCutover({ daemonUp: false });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("daemon unavailable");
    expect(result.dockerCalls).toEqual(["info"]);
    expect(result.curlCalls).toEqual([]);
  });

  it("fails closed on generic docker inspect errors instead of claiming no container", () => {
    const result = runCutover({ containerInspectError: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("docker inspect failed unexpectedly");
    expect(result.dockerCalls.join("\n")).not.toContain("update");
  });

  const metadataFailureModes: MetadataMode[] = [
    "http_fail",
    "missing_startup",
    "missing_redeploy",
    "old_startup",
    "old_redeploy",
  ];

  it.each(metadataFailureModes)("fails closed on %s metadata before any docker mutation", (mode) => {
    const result = runCutover({ policy: "unless-stopped", running: "true", metadataMode: mode });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.dockerCalls.join("\n")).not.toContain("update");
    expect(result.dockerCalls.join("\n")).not.toContain("stop");
  });

  it("rejects a stale payload that still carries every structural marker (hash binding)", () => {
    const result = runCutover({
      policy: "unless-stopped",
      running: "true",
      staleMarkedPayload: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("hash mismatch");
    expect(result.dockerCalls.join("\n")).not.toContain("update");
  });

  it("resumes an interrupted migration without repeating the policy update", () => {
    // Run 1: update lands, stop fails -> intermediate state.
    const run1 = runCutover({ policy: "unless-stopped", running: "true", stopFails: true });
    expect(run1.status).not.toBe(0);
    expect(run1.stderr).toContain("still running after stop");
    expect(run1.finalPolicy).toBe("no");

    // Run 2: resumes from policy=no + running=true; no second update.
    const run2 = runCutover({ policy: "no", running: "true" });
    expect(run2.status, run2.stderr).toBe(0);
    expect(run2.dockerCalls.join("\n")).not.toContain("update");
    expect(run2.finalRunning).toBe("false");
    expect(run2.stdout).toContain("safe to reboot");
  });

  it("binds its expected hashes to the exact reviewed startup.sh and redeploy.sh bytes", () => {
    const text = readFileSync(cutoverPath, { encoding: "utf8" });

    const embeddedStartup = text.match(/EXPECTED_STARTUP_SHA256="([0-9a-f]{64})"/u)?.[1];
    const embeddedRedeploy = text.match(/EXPECTED_REDEPLOY_SHA256="([0-9a-f]{64})"/u)?.[1];
    expect(embeddedStartup, "startup hash constant missing").toBeDefined();
    expect(embeddedRedeploy, "redeploy hash constant missing").toBeDefined();

    // The metadata payloads are byte-for-byte copies of these repo files
    // (compute.tf: file(...)), so the embedded digests must track them.
    // This test fails whenever either file changes without regenerating the
    // constants in the same change.
    expect(embeddedStartup).toBe(sha256(readFileSync(join(repoRoot, "infra", "startup.sh"), { encoding: "utf8" })));
    expect(embeddedRedeploy).toBe(sha256(readFileSync(join(repoRoot, "scripts", "redeploy.sh"), { encoding: "utf8" })));
  });

  it("fails closed when docker update fails, without stopping anything", () => {
    const result = runCutover({
      policy: "unless-stopped",
      running: "true",
      updateFails: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("docker update failed");
    expect(result.dockerCalls.join("\n")).not.toContain("stop");
    expect(result.finalRunning).toBe("true");
  });

  it("fails closed when stop fails or verification cannot confirm the stopped state", () => {
    const result = runCutover({
      policy: "unless-stopped",
      running: "true",
      stopFails: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("still running after stop");
    expect(result.finalRunning).toBe("true");
  });

  it("fails closed when post-update inspection becomes unavailable", () => {
    const result = runCutover({
      policy: "unless-stopped",
      running: "true",
      inspectFailAfterUpdate: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restart policy did not take effect");
    expect(result.stdout).not.toContain("safe to reboot");
  });
});
