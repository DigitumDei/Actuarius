import { describe, expect, it, vi } from "vitest";
import {
  collectChangeEvents,
  collectDrawerIds,
  collectKgEntities,
  collectKgRows,
  groupKgRowsByTriple,
  migratePalaceData,
  normalizeAddedBy,
  type ChangeEventRecord,
  type MigratedKgRow
} from "../src/services/memPalacePalaceMigrator.js";

interface RequestLog {
  method: string;
  url: string;
  body?: unknown;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface DrawerPostResult {
  status: number;
  body: unknown;
}

interface FetchPlan {
  changePages?: ChangeEventRecord[][];
  drawers?: Record<string, unknown>;
  kg?: Record<string, MigratedKgRow[]>;
  drawerPost?: (body: Record<string, unknown>) => DrawerPostResult;
}

function makeFetch(plan: FetchPlan) {
  const log: RequestLog[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
    log.push({ method, url: url.toString(), body });
    const path = url.pathname;
    if (method === "GET" && path === "/v1/changes") {
      const cursor = url.searchParams.get("cursor");
      const index = cursor ? Number(cursor) : 0;
      const pages = plan.changePages ?? [];
      const page = pages[index] ?? [];
      const hasNext = pages.length > index + 1;
      return json(200, { events: page, next_cursor: hasNext ? String(index + 1) : null });
    }
    if (method === "GET" && path.startsWith("/v1/drawers/")) {
      const id = decodeURIComponent(path.slice("/v1/drawers/".length));
      const drawer = plan.drawers?.[id];
      return drawer ? json(200, drawer) : json(404, { error: "not found" });
    }
    if (method === "POST" && path === "/v1/kg/query") {
      const entity = (body as { entity?: string } | undefined)?.entity ?? "";
      const facts = plan.kg?.[entity] ?? [];
      return json(200, { entity, facts, count: facts.length });
    }
    if (method === "POST" && path === "/v1/drawers") {
      const result = plan.drawerPost
        ? plan.drawerPost((body ?? {}) as Record<string, unknown>)
        : { status: 200, body: { success: true } };
      return json(result.status, result.body);
    }
    if (method === "POST" && path === "/v1/kg/facts") {
      return json(200, { success: true });
    }
    if (method === "POST" && path === "/v1/kg/facts/invalidate") {
      return json(200, { success: true });
    }
    return json(404, { error: "unexpected " + method + " " + path });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, log };
}

const SOURCE = "http://127.0.0.1:8791";
const TARGET = "http://127.0.0.1:8792";

function planWithTwoPages(): FetchPlan {
  return {
    changePages: [
      [
        { event_type: "drawer_added", occurred_at: "2026-01-01T00:00:00Z", entity_id: "d1" },
        { event_type: "drawer_added", occurred_at: "2026-01-01T00:00:01Z", entity_id: "d2" },
        { event_type: "kg_fact_added", occurred_at: "2026-01-01T00:00:02Z", entity_id: "t1", details: { subject: "A", predicate: "rel", object: "B" } }
      ],
      [
        { event_type: "drawer_deleted", occurred_at: "2026-01-02T00:00:00Z", entity_id: "d2" },
        { event_type: "kg_fact_added", occurred_at: "2026-01-02T00:00:01Z", entity_id: "t2", details: { subject: "B", predicate: "rel2", object: "C" } }
      ]
    ],
    drawers: {
      d1: { id: "d1", wing: "wing_x", room: "general", content: "hello", source_file: "a.ts", added_by: "opencode" },
      d2: { id: "d2", wing: "wing_x", room: "general", content: "deleted", source_file: "b.ts", added_by: "opencode" }
    },
    kg: {
      A: [{ subject: "A", predicate: "rel", object: "B", valid_from: "2026-01-01", valid_to: null }],
      B: [
        { subject: "A", predicate: "rel", object: "B", valid_from: "2026-01-01", valid_to: null },
        { subject: "B", predicate: "rel2", object: "C", valid_from: "2026-01-02", valid_to: "2026-03-01" }
      ],
      C: [{ subject: "B", predicate: "rel2", object: "C", valid_from: "2026-01-02", valid_to: "2026-03-01" }]
    }
  };
}

describe("memPalacePalaceMigrator", () => {
  it("pages the change feed to exhaustion", async () => {
    const { fetchImpl, log } = makeFetch(planWithTwoPages());
    const events = await collectChangeEvents(fetchImpl, SOURCE, "token");
    expect(events).toHaveLength(5);
    expect(log.filter((entry) => entry.url.includes("/v1/changes"))).toHaveLength(2);
  });

  it("collects added-but-not-deleted drawers and KG entities from the feed", () => {
    const events: ChangeEventRecord[] = [
      { event_type: "drawer_added", occurred_at: "x", entity_id: "d1" },
      { event_type: "drawer_added", occurred_at: "x", entity_id: "d2" },
      { event_type: "drawer_deleted", occurred_at: "x", entity_id: "d2" },
      { event_type: "kg_fact_added", occurred_at: "x", entity_id: "t1", details: { subject: "A", predicate: "rel", object: "B" } }
    ];
    expect(collectDrawerIds(events)).toEqual(["d1"]);
    expect(collectKgEntities(events).sort()).toEqual(["A", "B"]);
  });

  it("expands the KG from query results, not just the change-feed seeds", async () => {
    const { fetchImpl } = makeFetch({
      kg: {
        A: [{ subject: "A", predicate: "rel", object: "B", valid_from: null, valid_to: null }],
        B: [{ subject: "B", predicate: "rel", object: "C", valid_from: null, valid_to: null }],
        C: []
      }
    });
    const rows = await collectKgRows(fetchImpl, SOURCE, "token", ["A"]);
    expect(rows.map((row) => row.subject + "->" + row.object).sort()).toEqual(["A->B", "B->C"]);
  });

  it("copies current drawers and KG facts, skipping deleted drawers, and replays invalidations", async () => {
    const { fetchImpl, log } = makeFetch(planWithTwoPages());
    const summary = await migratePalaceData({ fromBaseUrl: SOURCE, toBaseUrl: TARGET, token: "token", fetchImpl });

    const drawerPosts = log.filter((entry) => entry.method === "POST" && entry.url === TARGET + "/v1/drawers");
    expect(drawerPosts).toHaveLength(1);
    expect(drawerPosts[0]?.body).toMatchObject({
      wing: "wing_x",
      room: "general",
      content: "hello",
      source_file: "a.ts",
      drawer_id: "d1",
      operation_id: "migrate:drawer:d1"
    });
    // The deleted drawer is never fetched.
    expect(log.some((entry) => entry.url === SOURCE + "/v1/drawers/d2")).toBe(false);

    const factPosts = log.filter((entry) => entry.method === "POST" && entry.url === TARGET + "/v1/kg/facts");
    expect(factPosts).toHaveLength(2);
    const invalidations = log.filter((entry) => entry.url === TARGET + "/v1/kg/facts/invalidate");
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]?.body).toMatchObject({ subject: "B", predicate: "rel2", object: "C", ended: "2026-03-01" });

    expect(summary).toMatchObject({
      changeEventsScanned: 5,
      drawersCopied: 1,
      drawersAlreadyPresent: 0,
      drawersNotFound: 0,
      kgFactsCopied: 2,
      kgFactsInvalidated: 1,
      errors: 0
    });
  });

  it("counts a near-duplicate that names the same drawer id as already present", async () => {
    const { fetchImpl } = makeFetch({
      ...planWithTwoPages(),
      drawerPost: () => ({
        status: 409,
        body: { code: "duplicate", message: "near-duplicate", matches: [{ id: "d1", wing: "wing_x", room: "general" }] }
      })
    });
    const summary = await migratePalaceData({ fromBaseUrl: SOURCE, toBaseUrl: TARGET, token: "token", fetchImpl });
    expect(summary.drawersCopied).toBe(0);
    expect(summary.drawersAlreadyPresent).toBe(1);
    expect(summary.errors).toBe(0);
  });

  it("reports a near-duplicate under a different id as an error, not as present", async () => {
    const { fetchImpl } = makeFetch({
      ...planWithTwoPages(),
      drawerPost: () => ({
        status: 409,
        body: { code: "duplicate", message: "near-duplicate", matches: [{ id: "some-other-drawer", wing: "wing_x", room: "general" }] }
      })
    });
    const summary = await migratePalaceData({ fromBaseUrl: SOURCE, toBaseUrl: TARGET, token: "token", fetchImpl });
    expect(summary.drawersAlreadyPresent).toBe(0);
    expect(summary.errors).toBe(1);
  });

  it("reports an operation_id_conflict as an error rather than swallowing it", async () => {
    const { fetchImpl } = makeFetch({
      ...planWithTwoPages(),
      drawerPost: () => ({ status: 409, body: { code: "operation_id_conflict", message: "reused operation id" } })
    });
    const summary = await migratePalaceData({ fromBaseUrl: SOURCE, toBaseUrl: TARGET, token: "token", fetchImpl });
    expect(summary.drawersAlreadyPresent).toBe(0);
    expect(summary.errors).toBe(1);
  });

  it("writes nothing in dry-run mode", async () => {
    const { fetchImpl, log } = makeFetch(planWithTwoPages());
    const summary = await migratePalaceData({ fromBaseUrl: SOURCE, toBaseUrl: TARGET, token: "token", fetchImpl, dryRun: true });
    expect(log.some((entry) => entry.method === "POST" && entry.url.startsWith(TARGET))).toBe(false);
    expect(summary.drawersCopied).toBe(1);
    expect(summary.kgFactsCopied).toBe(2);
  });

  it("counts per-item failures without aborting the rest of the migration", async () => {
    const plan = planWithTwoPages();
    const { fetchImpl } = makeFetch(plan);
    const failing: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (init?.method === "POST" && url.pathname === "/v1/drawers") return json(500, { error: "boom" });
      return fetchImpl(input, init);
    }) as unknown as typeof fetch;
    const summary = await migratePalaceData({ fromBaseUrl: SOURCE, toBaseUrl: TARGET, token: "token", fetchImpl: failing });
    expect(summary.errors).toBe(1);
    expect(summary.drawersCopied).toBe(0);
    expect(summary.kgFactsCopied).toBe(2);
  });

  it("replays an invalidated-then-re-added triple in ascending valid_from order", async () => {
    const triple = { subject: "A", predicate: "rel", object: "B" };
    const { fetchImpl, log } = makeFetch({
      changePages: [
        [
          { event_type: "kg_fact_added", occurred_at: "2026-01-01T00:00:00Z", entity_id: "t1", details: triple },
          { event_type: "kg_fact_added", occurred_at: "2026-01-02T00:00:00Z", entity_id: "t2", details: triple }
        ]
      ],
      // Fed newest-first to prove ordering does not depend on walk order.
      kg: {
        A: [
          { ...triple, valid_from: "2022-01-01", valid_to: null },
          { ...triple, valid_from: "2020-01-01", valid_to: "2021-01-01" }
        ],
        B: []
      }
    });
    const summary = await migratePalaceData({ fromBaseUrl: SOURCE, toBaseUrl: TARGET, token: "token", fetchImpl });

    const targetCalls = log.filter((entry) => entry.method === "POST" && entry.url.startsWith(TARGET) && entry.url.includes("/v1/kg/"));
    const sequence = targetCalls.map((entry) => {
      const body = (entry.body ?? {}) as Record<string, unknown>;
      if (entry.url.endsWith("/invalidate")) return "invalidate:" + String(body.ended);
      return "add:" + String(body.valid_from);
    });
    expect(sequence).toEqual(["add:2020-01-01", "invalidate:2021-01-01", "add:2022-01-01"]);

    const adds = targetCalls.filter((entry) => entry.url.endsWith("/v1/kg/facts"));
    const operationIds = adds.map((entry) => (entry.body as Record<string, unknown>).operation_id);
    expect(new Set(operationIds).size).toBe(2);
    expect(summary.kgFactsCopied).toBe(2);
    expect(summary.errors).toBe(0);
  });

  it("strips the migration identity prefix from added_by before re-posting", async () => {
    const { fetchImpl, log } = makeFetch({
      changePages: [
        [
          { event_type: "drawer_added", occurred_at: "x", entity_id: "d1" },
          { event_type: "drawer_added", occurred_at: "x", entity_id: "d2" },
          { event_type: "drawer_added", occurred_at: "x", entity_id: "d3" }
        ]
      ],
      drawers: {
        d1: { id: "d1", wing: "wing_x", room: "general", content: "one", added_by: "actuarius-local:claude" },
        d2: { id: "d2", wing: "wing_x", room: "general", content: "two", added_by: "actuarius-local" },
        d3: { id: "d3", wing: "wing_x", room: "general", content: "three", added_by: "claude" }
      }
    });
    await migratePalaceData({ fromBaseUrl: SOURCE, toBaseUrl: TARGET, token: "token", fetchImpl, identity: "actuarius-local" });
    const posts = log.filter((entry) => entry.method === "POST" && entry.url === TARGET + "/v1/drawers");
    const byId = new Map(posts.map((entry) => [(entry.body as Record<string, unknown>).drawer_id, entry.body as Record<string, unknown>]));
    expect(byId.get("d1")?.added_by).toBe("claude");
    expect(byId.get("d2")).not.toHaveProperty("added_by");
    expect(byId.get("d3")?.added_by).toBe("claude");
  });
});

describe("normalizeAddedBy", () => {
  it("strips one identity prefix and drops an identity-only author", () => {
    expect(normalizeAddedBy("actuarius-local:claude", "actuarius-local")).toBe("claude");
    expect(normalizeAddedBy("actuarius-local", "actuarius-local")).toBeUndefined();
    expect(normalizeAddedBy("actuarius-local:actuarius-local", "actuarius-local")).toBeUndefined();
    expect(normalizeAddedBy("claude", "actuarius-local")).toBe("claude");
    expect(normalizeAddedBy(null, "actuarius-local")).toBeUndefined();
    expect(normalizeAddedBy("claude", undefined)).toBe("claude");
  });
});

describe("groupKgRowsByTriple", () => {
  it("groups by triple and sorts each group oldest first", () => {
    const rows: MigratedKgRow[] = [
      { subject: "A", predicate: "rel", object: "B", valid_from: "2022-01-01", valid_to: null },
      { subject: "B", predicate: "other", object: "C", valid_from: "2019-01-01", valid_to: null },
      { subject: "A", predicate: "rel", object: "B", valid_from: "2020-01-01", valid_to: "2021-01-01" }
    ];
    const groups = groupKgRowsByTriple(rows);
    expect(groups).toHaveLength(2);
    const ab = groups.find((group) => group[0]?.subject === "A")!;
    expect(ab.map((row) => row.valid_from)).toEqual(["2020-01-01", "2022-01-01"]);
  });
});
