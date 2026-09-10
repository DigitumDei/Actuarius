import type { Logger } from "pino";

/**
 * One-palace consolidation migration.
 *
 * The two-palace era wrote every tracked wing, the knowledge graph, and (via
 * home-PC peers) nearly all non-diary data to a separate serve store. After the
 * consolidation the single palace is the old local store, so that data must be
 * copied across before the orphaned directory is deleted — otherwise deploy
 * resets memory for both the VM and every home PC.
 *
 * `mempalace-cli` has no offline merge/import command, so this module copies
 * data over the federation REST API. It reads the *change feed* rather than
 * `GET /v1/drawers` because drawer listing is capped and not cursor-pageable
 * (up to 200 rows, `next_cursor` always null), while a mined repo can have far
 * more drawers than that. The change feed is cursor-pageable and authoritative.
 *
 * The HTTP layer is injected so the copy logic can be tested without a live
 * palace; `src/tools/migrateMemPalace.ts` owns spawning the two temporary hubs.
 */

export interface ChangeEventRecord {
  event_type: string;
  occurred_at: string;
  entity_id: string;
  actor?: string | null;
  details?: Record<string, unknown> | null;
}

export interface MigratedDrawer {
  id: string;
  wing: string;
  room: string;
  content: string;
  source_file?: string | null;
  added_by?: string | null;
}

export interface MigratedKgRow {
  subject: string;
  predicate: string;
  object: string;
  valid_from?: string | null;
  valid_to?: string | null;
}

export interface MigrationLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface MigrationSummary {
  changeEventsScanned: number;
  drawersCopied: number;
  drawersAlreadyPresent: number;
  drawersNotFound: number;
  kgFactsCopied: number;
  kgFactsInvalidated: number;
  errors: number;
}

export interface MigratePalaceDataOptions {
  fromBaseUrl: string;
  toBaseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  logger?: Logger | MigrationLogger;
  dryRun?: boolean;
  pageLimit?: number;
}

const DEFAULT_PAGE_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noopLogger(): MigrationLogger {
  return { info: () => undefined, warn: () => undefined };
}

function asLogger(logger: Logger | MigrationLogger | undefined): MigrationLogger {
  if (!logger) return noopLogger();
  return {
    info: (obj, msg) => logger.info(obj, msg),
    warn: (obj, msg) => logger.warn(obj, msg)
  };
}

interface ApiResponse {
  status: number;
  body: unknown;
}

async function apiFetch(
  fetchImpl: typeof fetch,
  method: string,
  url: string,
  token: string,
  body?: unknown
): Promise<ApiResponse> {
  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

function endpoint(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Page the federation change feed to exhaustion. */
export async function collectChangeEvents(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
  pageLimit: number = DEFAULT_PAGE_LIMIT
): Promise<ChangeEventRecord[]> {
  const events: ChangeEventRecord[] = [];
  let cursor: string | null = null;
  for (;;) {
    const url = new URL(endpoint(baseUrl, "/v1/changes"));
    url.searchParams.set("limit", String(pageLimit));
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await apiFetch(fetchImpl, "GET", url.toString(), token);
    if (response.status !== 200) {
      throw new Error("GET /v1/changes failed with HTTP " + response.status);
    }
    const page = isRecord(response.body) ? response.body : {};
    const pageEvents = Array.isArray(page.events) ? page.events : [];
    for (const event of pageEvents) if (isRecord(event)) events.push(event as unknown as ChangeEventRecord);
    const next = page.next_cursor;
    cursor = typeof next === "string" && next.length > 0 ? next : null;
    if (!cursor) return events;
  }
}

/** Drawer ids that were added and are not deleted later in the feed. */
export function collectDrawerIds(events: ChangeEventRecord[]): string[] {
  const added = new Set<string>();
  const deleted = new Set<string>();
  for (const event of events) {
    if (event.event_type === "drawer_added") added.add(event.entity_id);
    else if (event.event_type === "drawer_deleted") deleted.add(event.entity_id);
  }
  return [...added].filter((id) => !deleted.has(id));
}

/** Entity names referenced by any KG change event. */
export function collectKgEntities(events: ChangeEventRecord[]): string[] {
  const entities = new Set<string>();
  for (const event of events) {
    if (event.event_type !== "kg_fact_added" && event.event_type !== "kg_fact_invalidated") continue;
    if (!isRecord(event.details)) continue;
    if (typeof event.details.subject === "string") entities.add(event.details.subject);
    if (typeof event.details.object === "string") entities.add(event.details.object);
  }
  return [...entities];
}

function toDrawer(value: unknown): MigratedDrawer | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.wing !== "string" || typeof value.room !== "string" || typeof value.content !== "string") {
    return null;
  }
  return {
    id: value.id,
    wing: value.wing,
    room: value.room,
    content: value.content,
    source_file: typeof value.source_file === "string" ? value.source_file : null,
    added_by: typeof value.added_by === "string" ? value.added_by : null
  };
}

export async function fetchDrawer(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
  drawerId: string
): Promise<MigratedDrawer | null> {
  const response = await apiFetch(fetchImpl, "GET", endpoint(baseUrl, "/v1/drawers/" + encodeURIComponent(drawerId)), token);
  if (response.status === 404) return null;
  if (response.status !== 200) throw new Error("GET /v1/drawers/" + drawerId + " failed with HTTP " + response.status);
  return toDrawer(response.body);
}

function kgRowKey(row: MigratedKgRow): string {
  return [row.subject, row.predicate, row.object, row.valid_from ?? "", row.valid_to ?? ""].join("\u0000");
}

/**
 * Collect KG facts by walking every entity reachable from the seed entities.
 * `GET /v1/kg/timeline` is capped and cannot page, and there is no entity-list
 * endpoint, so the change feed supplies the seed entities and `/v1/kg/query`
 * expands the graph until no new entity is found. Each fact carries its
 * `valid_from`/`valid_to`, so expired facts are preserved as invalidations.
 */
export async function collectKgRows(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
  seedEntities: string[]
): Promise<MigratedKgRow[]> {
  const visited = new Set<string>();
  const queue = [...seedEntities];
  const rows = new Map<string, MigratedKgRow>();
  while (queue.length > 0) {
    const entity = queue.shift()!;
    if (visited.has(entity)) continue;
    visited.add(entity);
    const response = await apiFetch(fetchImpl, "POST", endpoint(baseUrl, "/v1/kg/query"), token, {
      entity,
      direction: "both"
    });
    if (response.status !== 200) {
      throw new Error("POST /v1/kg/query for " + entity + " failed with HTTP " + response.status);
    }
    const facts = isRecord(response.body) && Array.isArray(response.body.facts) ? response.body.facts : [];
    for (const fact of facts) {
      if (!isRecord(fact)) continue;
      if (typeof fact.subject !== "string" || typeof fact.predicate !== "string" || typeof fact.object !== "string") continue;
      const row: MigratedKgRow = {
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        valid_from: typeof fact.valid_from === "string" ? fact.valid_from : null,
        valid_to: typeof fact.valid_to === "string" ? fact.valid_to : null
      };
      const key = kgRowKey(row);
      if (!rows.has(key)) rows.set(key, row);
      if (!visited.has(row.subject)) queue.push(row.subject);
      if (!visited.has(row.object)) queue.push(row.object);
    }
  }
  return [...rows.values()];
}

async function copyDrawer(
  fetchImpl: typeof fetch,
  toBaseUrl: string,
  token: string,
  drawer: MigratedDrawer,
  dryRun: boolean
): Promise<"copied" | "present" | "error"> {
  if (dryRun) return "copied";
  const response = await apiFetch(fetchImpl, "POST", endpoint(toBaseUrl, "/v1/drawers"), token, {
    wing: drawer.wing,
    room: drawer.room,
    content: drawer.content,
    source_file: drawer.source_file ?? null,
    added_by: drawer.added_by ?? null,
    drawer_id: drawer.id,
    operation_id: "migrate:drawer:" + drawer.id
  });
  // The idempotency receipt makes a replay of this exact migration succeed.
  // A 409 is a near-duplicate under a different id, which means the content
  // is already present on the target; treat it as converged, not a failure.
  if (response.status === 200 || response.status === 201) return "copied";
  if (response.status === 409) return "present";
  throw new Error("POST /v1/drawers for " + drawer.id + " failed with HTTP " + response.status);
}

async function copyKgFact(
  fetchImpl: typeof fetch,
  toBaseUrl: string,
  token: string,
  row: MigratedKgRow,
  dryRun: boolean
): Promise<void> {
  if (dryRun) return;
  const factKey = row.subject + "\u0000" + row.predicate + "\u0000" + row.object;
  const response = await apiFetch(fetchImpl, "POST", endpoint(toBaseUrl, "/v1/kg/facts"), token, {
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    valid_from: row.valid_from ?? null,
    operation_id: "migrate:kg:" + factKey
  });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error("POST /v1/kg/facts for " + factKey + " failed with HTTP " + response.status);
  }
  if (!row.valid_to) return;
  const invalidate = await apiFetch(fetchImpl, "POST", endpoint(toBaseUrl, "/v1/kg/facts/invalidate"), token, {
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    ended: row.valid_to,
    operation_id: "migrate:kg-invalidate:" + factKey + "\u0000" + row.valid_to
  });
  if (invalidate.status !== 200 && invalidate.status !== 201) {
    throw new Error("POST /v1/kg/facts/invalidate for " + factKey + " failed with HTTP " + invalidate.status);
  }
}

export async function migratePalaceData(options: MigratePalaceDataOptions): Promise<MigrationSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = asLogger(options.logger);
  const dryRun = options.dryRun ?? false;
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;

  const summary: MigrationSummary = {
    changeEventsScanned: 0,
    drawersCopied: 0,
    drawersAlreadyPresent: 0,
    drawersNotFound: 0,
    kgFactsCopied: 0,
    kgFactsInvalidated: 0,
    errors: 0
  };

  const events = await collectChangeEvents(fetchImpl, options.fromBaseUrl, options.token, pageLimit);
  summary.changeEventsScanned = events.length;
  logger.info({ events: events.length, dryRun }, "Scanned source palace change feed");

  const drawerIds = collectDrawerIds(events);
  for (const drawerId of drawerIds) {
    try {
      const drawer = await fetchDrawer(fetchImpl, options.fromBaseUrl, options.token, drawerId);
      if (!drawer) {
        summary.drawersNotFound += 1;
        continue;
      }
      const result = await copyDrawer(fetchImpl, options.toBaseUrl, options.token, drawer, dryRun);
      if (result === "copied") summary.drawersCopied += 1;
      else summary.drawersAlreadyPresent += 1;
    } catch (error) {
      summary.errors += 1;
      logger.warn({ drawerId, error: describeError(error) }, "Drawer migration failed");
    }
  }
  logger.info(
    { copied: summary.drawersCopied, alreadyPresent: summary.drawersAlreadyPresent, notFound: summary.drawersNotFound },
    "Drawers migrated"
  );

  const entities = collectKgEntities(events);
  const rows = await collectKgRows(fetchImpl, options.fromBaseUrl, options.token, entities);
  for (const row of rows) {
    try {
      await copyKgFact(fetchImpl, options.toBaseUrl, options.token, row, dryRun);
      summary.kgFactsCopied += 1;
      if (row.valid_to) summary.kgFactsInvalidated += 1;
    } catch (error) {
      summary.errors += 1;
      logger.warn({ fact: row.subject + " " + row.predicate + " " + row.object, error: describeError(error) }, "KG fact migration failed");
    }
  }
  logger.info({ facts: summary.kgFactsCopied, invalidated: summary.kgFactsInvalidated }, "KG facts migrated");

  return summary;
}
