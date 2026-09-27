import { describe, expect, it } from "vitest";
import type { EvidenceDigest, EvidenceItem } from "@nailed-it/protocol";
import { PROTOCOL_VERSION } from "@nailed-it/protocol";
import { flagEvidenceDigest, flagEvidenceItem, flagText, RedactionReason } from "./redact";

const makeItem = (overrides: Partial<EvidenceItem> = {}): EvidenceItem => ({
  id: overrides.id ?? "e1",
  source: overrides.source ?? "git_history",
  text: overrides.text ?? "Fictional Priya rewrote the retry logic three times before it shipped.",
  ...overrides,
});

describe("flagText: money amounts", () => {
  it("flags a dollar sign amount", () => {
    const flags = flagText("Fictional Priya paid $1,200 for the new monitor.");
    expect(flags.some((f) => f.reason === RedactionReason.MoneyAmount)).toBe(true);
  });

  it("flags a spelled-out currency amount", () => {
    const flags = flagText("Fictional Dev quoted 4500 USD for the contract.");
    expect(flags.some((f) => f.reason === RedactionReason.MoneyAmount)).toBe(true);
  });

  it("flags an abbreviated large amount", () => {
    const flags = flagText("Fictional Priya's runway is about $250k.");
    expect(flags.some((f) => f.reason === RedactionReason.MoneyAmount)).toBe(true);
  });

  it("does not flag plain numbers with no currency signal", () => {
    const flags = flagText("Fictional Priya has 1200 commits across her repos.");
    expect(flags.some((f) => f.reason === RedactionReason.MoneyAmount)).toBe(false);
  });
});

describe("flagText: email addresses", () => {
  it("flags a standard email address", () => {
    const flags = flagText("Reach fictional Priya at priya.dev+test@example.co for review requests.");
    expect(flags.some((f) => f.reason === RedactionReason.EmailAddress)).toBe(true);
  });

  it("flags an email embedded mid-sentence without spaces around it", () => {
    const flags = flagText("commit author:priya@example.com fixed the flaky test");
    expect(flags.some((f) => f.reason === RedactionReason.EmailAddress)).toBe(true);
  });
});

describe("flagText: phone numbers", () => {
  it("flags a hyphenated US phone number", () => {
    const flags = flagText("Call fictional Priya back at 415-555-0134 tomorrow.");
    expect(flags.some((f) => f.reason === RedactionReason.PhoneNumber)).toBe(true);
  });

  it("flags a phone number with a country code and parens", () => {
    const flags = flagText("Her number is +1 (415) 555-0134.");
    expect(flags.some((f) => f.reason === RedactionReason.PhoneNumber)).toBe(true);
  });
});

describe("flagText: URLs with tokens", () => {
  it("flags a URL carrying an access token query param", () => {
    const flags = flagText(
      "The dashboard link was https://ci.example.com/build?access_token=abcDEF12345secret in the log.",
    );
    expect(flags.some((f) => f.reason === RedactionReason.UrlWithToken)).toBe(true);
  });

  it("does not flag a plain URL with no credential-shaped query param", () => {
    const flags = flagText("She linked https://example.com/blog/post-about-rust in her notes.");
    expect(flags.some((f) => f.reason === RedactionReason.UrlWithToken)).toBe(false);
  });
});

describe("flagText: API-key-like strings", () => {
  it("flags an OpenAI-style secret key", () => {
    const flags = flagText("Old commit accidentally included sk-abcdefghijklmnopqrstuvwxyz123456.");
    expect(flags.some((f) => f.reason === RedactionReason.ApiKeyLike)).toBe(true);
  });

  it("flags a GitHub personal access token", () => {
    const flags = flagText("Found ghp_1234567890abcdefghijklmnopqrstuvwxyz in a .env.example.");
    expect(flags.some((f) => f.reason === RedactionReason.ApiKeyLike)).toBe(true);
  });

  it("flags a bare long random-looking token", () => {
    const flags = flagText("Env var was set to 8f3a9c2e1b7d4f6a0c5e9b2d7f1a3c6e9b2d7f1a in dev.");
    expect(flags.some((f) => f.reason === RedactionReason.ApiKeyLike)).toBe(true);
  });

  it("does not flag ordinary prose with no long tokens", () => {
    const flags = flagText("Fictional Priya prefers small composable functions over large ones.");
    expect(flags.some((f) => f.reason === RedactionReason.ApiKeyLike)).toBe(false);
  });
});

describe("flagText: health terms", () => {
  it("flags a therapy mention", () => {
    const flags = flagText("Fictional Priya mentioned her therapist recommended a slower pace.");
    expect(flags.some((f) => f.reason === RedactionReason.HealthTerm)).toBe(true);
  });

  it("flags a named mental-health condition", () => {
    const flags = flagText("She said her anxiety spikes before every demo day.");
    expect(flags.some((f) => f.reason === RedactionReason.HealthTerm)).toBe(true);
  });

  it("flags a medication mention", () => {
    const flags = flagText("Fictional Dev switched medication and it changed his sleep schedule.");
    expect(flags.some((f) => f.reason === RedactionReason.HealthTerm)).toBe(true);
  });

  it("does not flag unrelated use of a similar-looking word", () => {
    const flags = flagText("The team ran a surgery-precise refactor of the billing module.");
    // "surgery" as a metaphor still matches the word-level pattern; this
    // documents the intentional over-flagging bias (false positives are
    // safe here, false negatives are not).
    expect(flags.some((f) => f.reason === RedactionReason.HealthTerm)).toBe(true);
  });
});

describe("adversarial cases", () => {
  it("flags an item that combines multiple sensitive categories in one string", () => {
    const flags = flagText(
      "Paid $3,400 to priya@example.com, call 415-555-0199, key sk-abcdefghijklmnopqrstuvwxyz123456, dealing with anxiety.",
    );
    const reasons = new Set(flags.map((f) => f.reason));
    expect(reasons.has(RedactionReason.MoneyAmount)).toBe(true);
    expect(reasons.has(RedactionReason.EmailAddress)).toBe(true);
    expect(reasons.has(RedactionReason.PhoneNumber)).toBe(true);
    expect(reasons.has(RedactionReason.ApiKeyLike)).toBe(true);
    expect(reasons.has(RedactionReason.HealthTerm)).toBe(true);
  });

  it("flags an email hidden inside otherwise benign-looking git trailer text", () => {
    const flags = flagText("Signed-off-by: Fictional Priya <priya.fictional@example.org>");
    expect(flags.some((f) => f.reason === RedactionReason.EmailAddress)).toBe(true);
  });

  it("flags a phone number written with dots instead of dashes", () => {
    const flags = flagText("Voicemail box: 415.555.0134");
    expect(flags.some((f) => f.reason === RedactionReason.PhoneNumber)).toBe(true);
  });

  it("flags a Slack-bot-style token even without a recognizable prefix scheme", () => {
    const flags = flagText("legacy webhook secret q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8");
    expect(flags.some((f) => f.reason === RedactionReason.ApiKeyLike)).toBe(true);
  });

  it("still flags money written with a non-dollar currency symbol", () => {
    const flags = flagText("Invoice was €2.500 for the offsite.");
    expect(flags.some((f) => f.reason === RedactionReason.MoneyAmount)).toBe(true);
  });

  it("returns no flags for a clean, specific evidence item", () => {
    const flags = flagText(
      "Fictional Priya's last 40 commits touch the reducer module almost exclusively, always in the evening.",
    );
    expect(flags).toEqual([]);
  });

  it("never throws on empty or whitespace-only text", () => {
    expect(() => flagText("")).not.toThrow();
    expect(flagText("   ")).toEqual([]);
  });
});

describe("flagEvidenceItem", () => {
  it("flags based on the item's text field", () => {
    const item = makeItem({ text: "Contact fictional Priya at priya@example.com." });
    const flags = flagEvidenceItem(item);
    expect(flags.some((f) => f.reason === RedactionReason.EmailAddress)).toBe(true);
  });
});

describe("flagEvidenceDigest", () => {
  it("returns an entry for every item, including clean ones with an empty flags array", () => {
    const digest: EvidenceDigest = {
      protocolVersion: PROTOCOL_VERSION,
      digestId: "d1",
      displayName: "Fictional Priya",
      createdAt: "2026-09-27T00:00:00.000Z",
      items: [
        makeItem({ id: "clean-1", text: "She refactors in small commits with clear messages." }),
        makeItem({ id: "dirty-1", text: "Paid her $500 for the freelance gig, email priya@example.com." }),
      ],
    };

    const result = flagEvidenceDigest(digest);

    expect(result).toHaveLength(2);
    const clean = result.find((r) => r.itemId === "clean-1");
    const dirty = result.find((r) => r.itemId === "dirty-1");
    expect(clean?.flags).toEqual([]);
    expect(dirty?.flags.length).toBeGreaterThan(0);
  });

  it("never drops an item from the result, even when every item is flagged", () => {
    const digest: EvidenceDigest = {
      protocolVersion: PROTOCOL_VERSION,
      digestId: "d2",
      displayName: "Fictional Dev",
      createdAt: "2026-09-27T00:00:00.000Z",
      items: [
        makeItem({ id: "a", text: "Call 415-555-0134." }),
        makeItem({ id: "b", text: "Email dev@example.com." }),
      ],
    };

    const result = flagEvidenceDigest(digest);
    expect(result.map((r) => r.itemId).sort()).toEqual(["a", "b"]);
  });

describe("provider key formats", () => {
  it("flags a River-style key pasted into a session", () => {
    const flags = flagText("river key is rv_Zz9Yx8Wv7Ut6Sr5Qp4On-3Ml2Kj1Ih0Gf_EdCbA will add credits later");
    expect(flags.map((f) => f.reason)).toContain("api_key_like");
  });
});
});
