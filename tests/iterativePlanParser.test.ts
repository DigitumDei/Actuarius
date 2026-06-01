import { describe, expect, it } from "vitest";
import { parseIterativePlan, stripMarkdownJsonFence } from "../src/discord/bot.js";

describe("iterative plan parsing", () => {
  it("parses plain JSON", () => {
    expect(parseIterativePlan(JSON.stringify({
      overview: "Build the feature",
      tasks: [{ title: "Add service", description: "Implement the service layer" }]
    }))).toEqual({
      overview: "Build the feature",
      tasks: [{ title: "Add service", description: "Implement the service layer" }]
    });
  });

  it("ignores unknown top-level JSON fields", () => {
    expect(parseIterativePlan(JSON.stringify({
      overview: "Build the feature",
      tasks: [{ title: "Add service", description: "Implement the service layer" }],
      extra: "ignored"
    }))).toEqual({
      overview: "Build the feature",
      tasks: [{ title: "Add service", description: "Implement the service layer" }]
    });
  });

  it("strips json and bare markdown fences", () => {
    expect(stripMarkdownJsonFence("```json\n{\"ok\":true}\n```")).toBe("{\"ok\":true}");
    expect(stripMarkdownJsonFence("```\n{\"ok\":true}\n```")).toBe("{\"ok\":true}");
  });

  it("strips the first fenced JSON block when trailing prose follows", () => {
    const text = "```json\n{\"overview\":\"Plan\",\"tasks\":[{\"title\":\"Task\",\"description\":\"Do it\"}]}\n```\nTrailing note.";

    expect(parseIterativePlan(text)).toEqual({
      overview: "Plan",
      tasks: [{ title: "Task", description: "Do it" }]
    });
  });

  it("strips the first fenced JSON block when leading prose precedes it", () => {
    const text = "Here is the plan:\n```json\n{\"overview\":\"Plan\",\"tasks\":[{\"title\":\"Task\",\"description\":\"Do it\"}]}\n```\nTrailing note.";

    expect(parseIterativePlan(text)).toEqual({
      overview: "Plan",
      tasks: [{ title: "Task", description: "Do it" }]
    });
  });

  it("returns null for non-object JSON primitives", () => {
    expect(parseIterativePlan("null")).toBeNull();
    expect(parseIterativePlan("\"hello\"")).toBeNull();
    expect(parseIterativePlan("[]")).toBeNull();
  });

  it("returns null for empty tasks or malformed task entries", () => {
    expect(parseIterativePlan(JSON.stringify({ overview: "Plan", tasks: [] }))).toBeNull();
    expect(parseIterativePlan(JSON.stringify({
      overview: "Plan",
      tasks: [
        { title: "Missing description" },
        { description: "Missing title" },
        { title: "", description: "Blank title" },
        { title: "Blank description", description: "" }
      ]
    }))).toBeNull();
  });

  it("returns null when overview is empty", () => {
    expect(parseIterativePlan(JSON.stringify({
      overview: "",
      tasks: [{ title: "Task", description: "Do it" }]
    }))).toBeNull();
  });

  it("trims and caps task fields", () => {
    const longTitle = ` ${"A".repeat(200)} `;
    const longDescription = ` ${"B".repeat(9000)} `;
    const parsed = parseIterativePlan(JSON.stringify({
      overview: ` ${"O".repeat(3000)} `,
      tasks: [{ title: longTitle, description: longDescription }]
    }));

    expect(parsed).not.toBeNull();
    expect(parsed!.overview).toHaveLength(2000);
    expect(parsed!.tasks[0]!.title).toHaveLength(120);
    expect(parsed!.tasks[0]!.description).toHaveLength(8000);
  });
});
