import { describe, expect, it } from "vite-plus/test";

import { sanitizeToolActivityData, TOOL_ACTIVITY_PAYLOAD_LIMITS } from "./toolActivityPayload.ts";

const base64Blob = (chars: number) => "A".repeat(chars);

describe("sanitizeToolActivityData", () => {
  it("leaves undefined alone so the caller can omit the field", () => {
    expect(sanitizeToolActivityData(undefined)).toBeUndefined();
  });

  it("passes small payloads through unchanged", () => {
    const data = {
      toolCallId: "toolu_123",
      item: { command: "pnpm test", result: { stdout: "ok" } },
    };
    expect(sanitizeToolActivityData(data)).toEqual(data);
  });

  it("replaces a base64 data URL with a placeholder naming the mime type", () => {
    const data = { image: `data:image/png;base64,${base64Blob(4_000)}` };
    const result = sanitizeToolActivityData(data) as { image: string };
    expect(result.image).toBe("[image/png omitted, 3 KB]");
  });

  it("replaces a bare base64 image block payload", () => {
    const data = {
      content: [{ type: "image", source: { type: "base64", data: base64Blob(8_000) } }],
    };
    const result = sanitizeToolActivityData(data) as {
      content: Array<{ type: string; source: { type: string; data: string } }>;
    };
    expect(result.content[0]?.source.data).toBe("[binary omitted, 6 KB]");
    // Structure around the blob survives.
    expect(result.content[0]?.type).toBe("image");
    expect(result.content[0]?.source.type).toBe("base64");
  });

  it("does not mistake ordinary prose under a `data` key for base64", () => {
    const prose = "The quick brown fox jumps over the lazy dog. ".repeat(30);
    const result = sanitizeToolActivityData({ data: prose }) as { data: string };
    expect(result.data).toBe(prose);
  });

  it("leaves short base64-looking strings alone", () => {
    const short = base64Blob(64);
    const result = sanitizeToolActivityData({ data: short }) as { data: string };
    expect(result.data).toBe(short);
  });

  it("truncates oversized plain strings but keeps the leading content", () => {
    const text = `first line\n${"x".repeat(20_000)}`;
    const result = sanitizeToolActivityData({ stdout: text }) as { stdout: string };
    expect(result.stdout.startsWith("first line\n")).toBe(true);
    expect(result.stdout).toContain("truncated");
    expect(result.stdout.length).toBeLessThan(text.length);
  });

  it("caps long arrays and records how many were dropped", () => {
    const data = { files: Array.from({ length: 500 }, (_, index) => `file-${index}.ts`) };
    const result = sanitizeToolActivityData(data) as { files: string[] };
    expect(result.files).toHaveLength(TOOL_ACTIVITY_PAYLOAD_LIMITS.maxArrayItems + 1);
    expect(result.files[0]).toBe("file-0.ts");
    expect(result.files.at(-1)).toBe("[300 more items omitted]");
  });

  it("stops recursing past the depth limit", () => {
    let nested: Record<string, unknown> = { leaf: "value" };
    for (let index = 0; index < 40; index += 1) {
      nested = { child: nested };
    }
    const serialized = JSON.stringify(sanitizeToolActivityData(nested));
    expect(serialized).toContain("[object omitted]");
  });

  it("preserves the fields the timeline extracts from a screenshot result", () => {
    const data = {
      toolCallId: "toolu_016EqrZkbsJCj9tkzCvFctUN",
      toolName: "mcp__chrome-devtools__take_screenshot",
      input: { format: "png" },
      item: { command: null, filePath: "src/app.tsx" },
      result: {
        tool_use_id: "toolu_016EqrZkbsJCj9tkzCvFctUN",
        type: "tool_result",
        content: [
          { type: "text", text: "Took a screenshot of the current page's viewport." },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: base64Blob(1_400_000) },
          },
        ],
      },
    };

    const before = JSON.stringify(data).length;
    const result = sanitizeToolActivityData(data) as typeof data;
    const after = JSON.stringify(result).length;

    expect(after).toBeLessThan(2_000);
    expect(before / after).toBeGreaterThan(100);
    expect(result.toolCallId).toBe("toolu_016EqrZkbsJCj9tkzCvFctUN");
    expect(result.toolName).toBe("mcp__chrome-devtools__take_screenshot");
    expect(result.input.format).toBe("png");
    expect(result.item.filePath).toBe("src/app.tsx");
    expect(result.result.content[0]?.text).toBe(
      "Took a screenshot of the current page's viewport.",
    );
  });

  it("trims a wide payload that survives per-leaf capping", () => {
    const data: Record<string, string> = {};
    for (let index = 0; index < 200; index += 1) {
      data[`key-${index}`] = "y".repeat(2_000);
    }
    const result = sanitizeToolActivityData(data);
    const serialized = JSON.stringify(result) ?? "";
    expect(serialized.length).toBeLessThanOrEqual(
      TOOL_ACTIVITY_PAYLOAD_LIMITS.maxTotalChars + 8_000,
    );
    expect(serialized).toContain("[omitted, payload too large]");
    // Earlier keys are kept in full so extraction still finds something.
    expect((result as Record<string, string>)["key-0"]).toBe("y".repeat(2_000));
  });

  it("does not throw on circular structures", () => {
    const circular: Record<string, unknown> = { name: "root" };
    circular.self = circular;
    expect(() => sanitizeToolActivityData(circular)).not.toThrow();
  });
});
