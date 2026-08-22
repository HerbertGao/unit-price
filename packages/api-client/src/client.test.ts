import { describe, expect, it } from "vitest";
import { buildRankingsUrl } from "./client.js";

describe("buildRankingsUrl", () => {
  it("returns /rankings for canonical origins", () => {
    expect(buildRankingsUrl("https://api.example.com")).toBe(
      "https://api.example.com/rankings",
    );
    expect(buildRankingsUrl("https://api.example.com/")).toBe(
      "https://api.example.com/rankings",
    );
    expect(buildRankingsUrl("https://api.example.com:8080")).toBe(
      "https://api.example.com:8080/rankings",
    );
  });

  it.each([
    "https://api.example.com/v1",
    "https://api.example.com?a=1",
    "https://api.example.com#x",
    "",
    "ftp://api.example.com",
    "https://user:pw@api.example.com",
    "https://api.example.com/.",
    "https:api.example.com",
    "https://api.example.com:443",
    "https://API.EXAMPLE.COM",
    "HTTP://api.example.com",
    "https://api.example.com//",
  ])("fails fast for non-canonical base %j", (base) => {
    expect(() => buildRankingsUrl(base)).toThrow();
  });
});
