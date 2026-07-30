import { describe, expect, it } from "vitest";
import { sanitizeGrantModules } from "../services";

describe("access grant contract", () => {
  it("keeps only controlled modules and removes legacy signing grants", () => {
    expect(
      sanitizeGrantModules([
        "documentReview",
        "caseLawPack",
        "unknown-module",
        "evidencePack",
        "caseLawPack"
      ])
    ).toEqual(["caseLawPack", "evidencePack"]);
  });
});
