import { describe, expect, it } from "vitest";
import { extractStreamingSummary } from "../../src/ai/stream-preview.js";

describe("AI streaming preview", () => {
  it("extracts and decodes a partial summary without exposing JSON keys", () => {
    const raw = '{"schemaVersion":"1.0","summary":"公司提出协商\\n解除，建议先核对\\"补偿协议\\"';

    expect(extractStreamingSummary(raw)).toBe(
      '公司提出协商\n解除，建议先核对"补偿协议"'
    );
    expect(extractStreamingSummary('{"schemaVersion":"1.0"')).toBe("");
  });

  it("keeps a completed summary stable when later fields arrive", () => {
    const raw = JSON.stringify({
      schemaVersion: "1.0",
      summary: "请先保全解除通知和工资流水。",
      riskLevel: "medium"
    });

    expect(extractStreamingSummary(raw)).toBe("请先保全解除通知和工资流水。");
  });
});
