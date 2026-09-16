import type { Logger } from "pino";
import { homedir } from "node:os";
import { runProviderRequest, type ProviderErrorDetails, type ProviderRequestInput, type ProviderTimeoutKind } from "../utils/runProviderRequest.js";
import {
  AGY_BINARY,
  buildAntigravityStreamPrompt,
  detectAntigravityResultFailure,
  ensureAntigravityApiKeyConfig,
  extractAntigravityStreamResponse,
  prefersAntigravityAccountAuth
} from "./antigravityCli.js";

export interface GeminiExecutionInput extends ProviderRequestInput {}

export interface GeminiExecutionResult {
  text: string;
}

export class GeminiExecutionError extends Error {
  public readonly code: "GEMINI_UNAVAILABLE" | "GEMINI_DISABLED" | "NOT_AUTHENTICATED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT";
  public partialStdout?: string;
  public partialStderr?: string;
  public timeoutKind?: ProviderTimeoutKind;
  public timeoutMs?: number;
  public providerSessionId?: string;
  public lastActivity?: string;

  public constructor(code: "GEMINI_UNAVAILABLE" | "GEMINI_DISABLED" | "NOT_AUTHENTICATED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT", message: string) {
    super(message);
    this.name = "GeminiExecutionError";
    this.code = code;
  }
}

/**
 * Run a request through Google's Antigravity CLI (`agy`), the successor to the
 * Gemini CLI. The provider identity stays `gemini` (persisted model config and
 * `GEMINI_API_KEY` are unchanged), but the executing binary is `agy`.
 *
 * Verified Antigravity CLI contract (`https://www.antigravity.google/docs/cli/headless/`):
 * - `agy -p "<prompt>"` runs headlessly; response text on stdout, diagnostics
 *   on stderr. Exit code 0 on success, non-zero on failure.
 * - Tool approval uses `--dangerously-skip-permissions` (the documented
 *   headless analogue of the legacy Gemini `--yolo`; there is no `--yolo` and
 *   no raw-stdin prompt fallback).
 * - Oversized prompts are transported via the documented streaming stdin
 *   protocol: `--input-format stream-json` + a `user` event line on stdin,
 *   with `--output-format stream-json` events on stdout (terminal `result`
 *   event carries `response`).
 * - API-key auth requires `modelProvider: "gemini"` in
 *   `~/.gemini/antigravity-cli/settings.json` AND `GEMINI_API_KEY`; the key
 *   alone has no effect, and `agy` will not start if the marker is set without
 *   the key. Actuarius writes the marker (preserving unrelated keys) only when
 *   the key is present in the child environment.
 * - Without a key, `agy` runs under the operator's signed-in account session
 *   (keyring or SSH OAuth). A completed Discord login records account auth as
 *   preferred, which also suppresses a deployed fallback key for child runs.
 */
export async function runGeminiRequest(input: GeminiExecutionInput, logger: Logger): Promise<GeminiExecutionResult> {
  // API-key auth needs the settings marker; account auth must NOT have it, or
  // agy refuses to start. Decide from the environment the child actually
  // receives, and merge the marker only when the key is visible to it.
  const effectiveEnv = input.env ?? process.env;
  const home = effectiveEnv.HOME ?? homedir();
  const preferAccountAuth = await prefersAntigravityAccountAuth(home);
  const useApiKey = !preferAccountAuth && !!effectiveEnv.GEMINI_API_KEY?.trim();
  await ensureAntigravityApiKeyConfig(logger, home, useApiKey);

  // Production may still inject GEMINI_API_KEY after an administrator signs
  // in with Google. Remove it from agy's child environment while the persisted
  // account preference is active so the CLI cannot silently switch modes.
  let executionInput = input;
  if (preferAccountAuth) {
    const accountEnv: NodeJS.ProcessEnv = { ...effectiveEnv };
    delete accountEnv.GEMINI_API_KEY;
    executionInput = { ...input, env: accountEnv };
  }

  const text = await runProviderRequest(
    executionInput,
    {
      binary: AGY_BINARY,
      // agy's own response deadline must not exceed Actuarius's total request
      // deadline. It accepts human-readable durations (for example "15m").
      extraArgs: [
        "--dangerously-skip-permissions",
        "--print-timeout",
        `${Math.max(1, Math.ceil(input.timeoutMs / 1000))}s`
      ],
      // Gemini's `-p ""` + raw-stdin fallback does NOT transfer to agy. The
      // documented input contract is a JSON streaming protocol on stdin, so
      // oversized prompts switch to `--input-format stream-json` and write a
      // `user` event; stdout (stream-json NDJSON) is decoded by
      // `extractAntigravityStreamResponse`, which also passes the plain `text`
      // output of the small-prompt argv path through untouched.
      supportsStdinFallback: true,
      stdinStreamArgs: ["--input-format", "stream-json", "--output-format", "stream-json"],
      stdinStreamPrompt: buildAntigravityStreamPrompt,
      transformOutput: (stdout) => extractAntigravityStreamResponse(stdout, true),
      transformOutputOnlyForStream: true,
      // agy can exit 0 while its terminal stream-json result reports a non-SUCCESS
      // status (ERROR/CANCELED/INTERRUPTED/INVALID/WAITING/RUNNING); surface
      // those as provider failures rather than returning a partial response.
      validateOutput: (stdout) => {
        const failure = detectAntigravityResultFailure(stdout, true);
        if (!failure) return undefined;
        const detail = failure.error ? `: ${failure.error}` : "";
        return {
          code: "FAILED",
          message: `Antigravity CLI run ended with status ${failure.status}${detail}`
        };
      },
      validateOutputOnlyForStream: true,
      logLabel: "Antigravity",
      makeError: (code, message, details) => {
        const err = new GeminiExecutionError(code as GeminiExecutionError["code"], message);
        if (details) {
          Object.assign(err, details satisfies ProviderErrorDetails);
        }
        return err;
      },
      unavailableCode: "GEMINI_UNAVAILABLE",
      notAuthenticatedCode: "NOT_AUTHENTICATED",
      // agy writes diagnostics and auth prompts to stderr and the task
      // response to stdout, so only stderr is inspected. Matching stdout would
      // false-positive on arbitrary text the agent prints while working.
      authCheckOnlyStderr: true,
      authFailurePattern: /authentication required|not authenticated|Enter the authorization code:|GEMINI_API_KEY is not set|set an Auth method/i,
      authHint: "Run `/auth-antigravity` to connect a Google account, or set `GEMINI_API_KEY` for API-key auth.",
      timeoutCode: "TIMEOUT",
      failedCode: "FAILED",
      emptyOutputCode: "EMPTY_OUTPUT",
    },
    logger
  );
  return { text };
}
