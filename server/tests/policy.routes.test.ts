import { describe, expect, it } from "vitest";
import { calendarDateInShanghai } from "../modules/policy/routes.js";

describe("policy administration calendar boundary", () => {
  it("rolls the business date at 00:00 in Asia/Shanghai", () => {
    expect(
      calendarDateInShanghai(new Date("2026-07-30T15:59:59.999Z"))
    ).toBe("2026-07-30");
    expect(
      calendarDateInShanghai(new Date("2026-07-30T16:00:00.000Z"))
    ).toBe("2026-07-31");
  });
});
