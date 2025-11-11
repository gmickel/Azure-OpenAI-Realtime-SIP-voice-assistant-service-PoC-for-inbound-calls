import { describe, expect, test } from "bun:test";

import { redactPII } from "../observe";

describe("redactPII", () => {
  test("scrubs emails and phone numbers", () => {
    const input = "Email me at user@example.com or call +1 (555) 123-4567 ASAP";
    const result = redactPII(input);
    expect(result).not.toContain("example.com");
    expect(result).not.toContain("555");
    expect(result).toContain("[REDACTED]");
  });
});
