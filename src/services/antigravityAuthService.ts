import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import type { Logger } from "pino";
import {
  AGY_BINARY,
  ensureAntigravityApiKeyConfig,
  prefersAntigravityAccountAuth,
  setAntigravityAccountAuthPreference
} from "./antigravityCli.js";
import { signalChildTree } from "../utils/spawnCollect.js";

const DEFAULT_URL_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 60_000;
const AUTH_KILL_GRACE_MS = 2_000;
const OUTPUT_TAIL_LIMIT = 64 * 1024;
const AUTH_SUCCESS_PATTERN =
  /loaded cached credentials|credentials saved|successfully authenticated|authentication (?:complete|successful)|successfully logged in|login successful|signed in|welcome to antigravity/i;

export type AntigravityAuthErrorCode =
  | "UNAVAILABLE"
  | "URL_TIMEOUT"
  | "SESSION_EXPIRED"
  | "FAILED";

export class AntigravityAuthError extends Error {
  public constructor(
    public readonly code: AntigravityAuthErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AntigravityAuthError";
  }
}

export interface AntigravityGoogleAuthSession {
  readonly url: string;
  isActive(): boolean;
  complete(code: string): Promise<void>;
  cancel(): Promise<void>;
}

export interface StartAntigravityGoogleAuthOptions {
  cwd: string;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  urlTimeoutMs?: number;
  sessionTimeoutMs?: number;
  completionTimeoutMs?: number;
}

export function parseAntigravityGoogleAuthUrl(output: string): string | undefined {
  const plain = stripVTControlCharacters(output);
  const candidates = plain.match(/https:\/\/accounts\.google\.com\/[^\s<>"']+/gu) ?? [];
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/[),.;\]}]+$/u, "");
    try {
      const url = new URL(cleaned);
      if (url.protocol === "https:" && url.hostname === "accounts.google.com") {
        return url.toString();
      }
    } catch {
      // Keep looking if a partial terminal chunk produced an invalid URL.
    }
  }
  return undefined;
}

export async function startAntigravityGoogleAuth(
  options: StartAntigravityGoogleAuthOptions
): Promise<AntigravityGoogleAuthSession> {
  const sourceEnv = options.env ?? process.env;
  const home = sourceEnv.HOME ?? homedir();
  const hadAccountPreference = await prefersAntigravityAccountAuth(home);
  const hadApiKey = !!sourceEnv.GEMINI_API_KEY?.trim();

  // agy refuses account login while the API-key provider selector is present.
  await ensureAntigravityApiKeyConfig(options.logger, home, false);

  const childEnv: NodeJS.ProcessEnv = { ...sourceEnv };
  delete childEnv.GEMINI_API_KEY;
  childEnv.TERM ??= "xterm-256color";
  childEnv.COLUMNS ??= "4096";
  // Force the documented remote-login path: the container has no browser, and
  // Discord is the terminal through which the operator receives the URL/code.
  childEnv.SSH_CONNECTION ??= "127.0.0.1 1 127.0.0.1 1";

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      "script",
      ["-qefc", "stty cols 4096 2>/dev/null || true; exec " + AGY_BINARY, "/dev/null"],
      {
        cwd: options.cwd,
        env: childEnv,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
  } catch (error) {
    await ensureAntigravityApiKeyConfig(
      options.logger,
      home,
      hadAccountPreference ? false : hadApiKey
    );
    throw new AntigravityAuthError(
      "UNAVAILABLE",
      "Could not start Antigravity authentication: "
        + (error instanceof Error ? error.message : String(error))
    );
  }

  let active = true;
  let urlFound = false;
  let authUrl = "";
  let codeSubmitted = false;
  let closed = false;
  let outputTail = "";
  let postCodeOutput = "";
  let forceKillTimer: NodeJS.Timeout | undefined;
  let sessionTimer: NodeJS.Timeout | undefined;
  let completionTimer: NodeJS.Timeout | undefined;
  let completionResolve: (() => void) | undefined;
  let completionReject: ((error: Error) => void) | undefined;
  let transitionInProgress = false;

  const terminate = (): void => {
    if (closed || child.killed) return;
    signalChildTree(child, "SIGTERM");
    if (forceKillTimer) return;
    forceKillTimer = setTimeout(() => {
      if (!closed) signalChildTree(child, "SIGKILL");
    }, AUTH_KILL_GRACE_MS);
    forceKillTimer.unref();
  };

  const clearTimers = (): void => {
    if (sessionTimer) clearTimeout(sessionTimer);
    if (completionTimer) clearTimeout(completionTimer);
    if (forceKillTimer && closed) clearTimeout(forceKillTimer);
  };

  const restorePreviousMode = async (): Promise<void> => {
    await ensureAntigravityApiKeyConfig(
      options.logger,
      home,
      hadAccountPreference ? false : hadApiKey
    );
  };

  const rejectCompletion = (error: Error): void => {
    const reject = completionReject;
    completionResolve = undefined;
    completionReject = undefined;
    reject?.(error);
  };

  const fail = async (error: Error, restore = true): Promise<void> => {
    if (transitionInProgress) return;
    transitionInProgress = true;
    active = false;
    clearTimers();
    terminate();
    if (restore) {
      try {
        await restorePreviousMode();
      } catch (restoreError) {
        options.logger.warn(
          { err: restoreError },
          "Failed to restore Antigravity authentication mode after login failure"
        );
      }
    }
    rejectCompletion(error);
  };

  const succeed = async (): Promise<void> => {
    if (transitionInProgress) return;
    transitionInProgress = true;
    clearTimers();
    try {
      await setAntigravityAccountAuthPreference(true, home);
      await ensureAntigravityApiKeyConfig(options.logger, home, false);
      active = false;
      terminate();
      const resolve = completionResolve;
      completionResolve = undefined;
      completionReject = undefined;
      resolve?.();
    } catch (error) {
      if (!hadAccountPreference) {
        await setAntigravityAccountAuthPreference(false, home).catch(() => undefined);
      }
      transitionInProgress = false;
      await fail(
        new AntigravityAuthError(
          "FAILED",
          "Google authenticated, but Actuarius could not persist the account preference: "
            + (error instanceof Error ? error.message : String(error))
        )
      );
    }
  };

  let resolveUrl!: (session: AntigravityGoogleAuthSession) => void;
  let rejectUrl!: (error: Error) => void;
  const urlPromise = new Promise<AntigravityGoogleAuthSession>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });

  const session: AntigravityGoogleAuthSession = {
    get url(): string {
      return authUrl;
    },
    isActive: () => active && !closed,
    complete: async (rawCode: string): Promise<void> => {
      const code = rawCode.trim();
      if (!code || code.length > 2_048 || /[\r\n]/u.test(code)) {
        throw new AntigravityAuthError("FAILED", "The Google authorization code is invalid.");
      }
      if (!active || closed) {
        throw new AntigravityAuthError(
          "SESSION_EXPIRED",
          "The Antigravity login session expired. Run /auth-antigravity again."
        );
      }
      if (codeSubmitted) {
        throw new AntigravityAuthError("FAILED", "An authorization code was already submitted.");
      }

      codeSubmitted = true;
      const result = new Promise<void>((resolve, reject) => {
        completionResolve = resolve;
        completionReject = reject;
      });
      completionTimer = setTimeout(() => {
        void fail(
          new AntigravityAuthError(
            "SESSION_EXPIRED",
            "Timed out waiting for Antigravity to accept the Google authorization code."
          )
        );
      }, options.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS);
      completionTimer.unref();

      child.stdin.once("error", (error) => {
        void fail(
          new AntigravityAuthError(
            "FAILED",
            "Could not send the Google authorization code to Antigravity: " + error.message
          )
        );
      });
      child.stdin.write(code + "\n", (error) => {
        if (error) {
          void fail(
            new AntigravityAuthError(
              "FAILED",
              "Could not send the Google authorization code to Antigravity: " + error.message
            )
          );
        }
      });
      await result;
    },
    cancel: async (): Promise<void> => {
      if (!active) return;
      await fail(
        new AntigravityAuthError("SESSION_EXPIRED", "Antigravity login was cancelled.")
      );
    }
  };

  const acceptOutput = (chunk: Buffer | string): void => {
    outputTail = (outputTail + chunk.toString()).slice(-OUTPUT_TAIL_LIMIT);
    if (codeSubmitted) {
      postCodeOutput = (postCodeOutput + chunk.toString()).slice(-OUTPUT_TAIL_LIMIT);
    }
    if (!urlFound) {
      const url = parseAntigravityGoogleAuthUrl(outputTail);
      if (url) {
        authUrl = url;
        urlFound = true;
        resolveUrl(session);
      }
    }
    if (
      codeSubmitted
      && (
        AUTH_SUCCESS_PATTERN.test(stripVTControlCharacters(postCodeOutput))
        || postCodeOutput.includes("\u001b[?1049h")
      )
    ) {
      void succeed();
    }
  };

  child.stdout.on("data", acceptOutput);
  child.stderr.on("data", acceptOutput);

  child.once("error", (error) => {
    const authError = new AntigravityAuthError(
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "UNAVAILABLE" : "FAILED",
      "Antigravity authentication could not start: " + error.message
    );
    if (!urlFound) rejectUrl(authError);
    void fail(authError);
  });

  child.once("close", (code) => {
    closed = true;
    clearTimers();
    if (!urlFound) {
      active = false;
      const error = new AntigravityAuthError(
        "FAILED",
        "Antigravity exited with code " + String(code)
          + " before producing a Google sign-in link."
      );
      rejectUrl(error);
      void restorePreviousMode();
      return;
    }
    if (codeSubmitted && code === 0) {
      void succeed();
      return;
    }
    if (active || completionReject) {
      void fail(
        new AntigravityAuthError(
          "FAILED",
          "Antigravity exited with code " + String(code)
            + " before confirming Google authentication."
        )
      );
    }
  });

  const urlTimer = setTimeout(() => {
    if (urlFound) return;
    const error = new AntigravityAuthError(
      "URL_TIMEOUT",
      "Timed out waiting for Antigravity to produce a Google sign-in link."
    );
    rejectUrl(error);
    void fail(error);
  }, options.urlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS);
  urlTimer.unref();
  void urlPromise.finally(() => clearTimeout(urlTimer)).catch(() => undefined);

  sessionTimer = setTimeout(() => {
    if (!active) return;
    options.logger.info("Antigravity Google authentication session expired");
    void fail(
      new AntigravityAuthError(
        "SESSION_EXPIRED",
        "The Antigravity login session expired. Run /auth-antigravity again."
      )
    );
  }, options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS);
  sessionTimer.unref();

  return urlPromise;
}