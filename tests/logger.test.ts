import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";

function createLogCapture(): { writer: Writable; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  const writer = new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      for (const line of chunk.toString().trim().split("\n")) {
        try {
          records.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // skip non-JSON lines
        }
      }
      callback();
    }
  });
  return { writer, records };
}

describe("logger error serializer", () => {
  it("serializes an Error logged under the `error` key instead of producing {}", () => {
    const { writer, records } = createLogCapture();
    const logger = pino({ serializers: { error: pino.stdSerializers.err } }, writer);

    logger.warn({ error: new Error("boom") }, "something failed");

    expect(records).toHaveLength(1);
    expect(records[0]?.error).toMatchObject({ message: "boom", stack: expect.stringContaining("boom") });
  });

  it("passes through non-Error values under the `error` key unchanged", () => {
    const { writer, records } = createLogCapture();
    const logger = pino({ serializers: { error: pino.stdSerializers.err } }, writer);

    logger.warn({ error: "already a string" }, "something failed");

    expect(records[0]?.error).toBe("already a string");
  });
});
