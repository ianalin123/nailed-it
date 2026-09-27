// Pure redaction-flagging functions for EvidenceDigest items.
//
// These functions never delete or alter evidence text. They only detect
// categories of sensitive content and report *why* an item was flagged, so
// the owner-approval step can show every flag and let the owner opt items
// back in one at a time. Silently dropping content anywhere in this module
// would defeat that review step.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { EvidenceDigest, EvidenceItem } from "@nailed-it/protocol";

export const RedactionReason = {
  MoneyAmount: "money_amount",
  EmailAddress: "email_address",
  PhoneNumber: "phone_number",
  UrlWithToken: "url_with_token",
  ApiKeyLike: "api_key_like",
  HealthTerm: "health_term",
} as const;

export type RedactionReason = (typeof RedactionReason)[keyof typeof RedactionReason];

export interface RedactionFlag {
  reason: RedactionReason;
  match: string;
}

export interface EvidenceItemFlags {
  itemId: string;
  flags: RedactionFlag[];
}

interface Matcher {
  reason: RedactionReason;
  pattern: RegExp;
}

// Order matters only for readability of output; every matcher runs over
// every item regardless of earlier matches.
const MATCHERS: Matcher[] = [
  {
    reason: RedactionReason.MoneyAmount,
    pattern:
      /(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|mm|bn|million|billion|thousand))?)|(?:\b\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|cad|aud|dollars?|bucks|euros?|pounds?)\b)/gi,
  },
  {
    reason: RedactionReason.EmailAddress,
    pattern: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
  },
  {
    reason: RedactionReason.PhoneNumber,
    pattern: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
  },
  {
    reason: RedactionReason.UrlWithToken,
    pattern:
      /https?:\/\/\S*[?&](?:token|key|secret|access_token|api_key|auth|session|password)=[^\s&]+/gi,
  },
  {
    reason: RedactionReason.ApiKeyLike,
    pattern:
      /\b(?:sk-[a-z0-9]{20,}|rv_[a-z0-9_-]{20,}|ghp_[a-z0-9]{20,}|gho_[a-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[a-z0-9-]{10,}|Bearer\s+[a-z0-9._-]{20,}|[a-z0-9_-]{32,})\b/gi,
  },
  {
    reason: RedactionReason.HealthTerm,
    pattern:
      /\b(?:diagnos(?:is|ed|es)|therapy|therapist|psychiatrist|psychologist|medication|prescri(?:ption|bed)|antidepressant|anxiety|depression|adhd|bipolar|ptsd|ocd|eating disorder|addiction|rehab|chemo(?:therapy)?|cancer|tumor|surgery|hospitali[sz]ed|disability|autoimmune|chronic (?:illness|pain|condition)|mental health|suicid\w*)\b/gi,
  },
];

const findMatches = (text: string, matcher: Matcher): RedactionFlag[] => {
  const found = text.match(matcher.pattern);
  if (found === null) return [];
  return found.map((match) => ({ reason: matcher.reason, match }));
};

/** Flags every sensitive-content match found in a single string. */
export const flagText = (text: string): RedactionFlag[] =>
  MATCHERS.flatMap((matcher) => findMatches(text, matcher));

/** Flags a single evidence item's text. */
export const flagEvidenceItem = (item: EvidenceItem): RedactionFlag[] => flagText(item.text);

/**
 * Flags every item in a digest. Every item id appears in the result, even
 * with an empty flags array, so nothing is silently omitted from review.
 */
export const flagEvidenceDigest = (digest: EvidenceDigest): EvidenceItemFlags[] =>
  digest.items.map((item) => ({ itemId: item.id, flags: flagEvidenceItem(item) }));

// --- CLI wrapper -----------------------------------------------------------
// Convenience entry point over the pure functions above: reads a digest JSON
// file and prints each item's flags. Never writes or mutates the digest.

interface CliResult {
  digestId: string;
  flaggedCount: number;
  items: EvidenceItemFlags[];
}

export const runCli = (argv: string[]): CliResult => {
  const filePath = argv[0];
  if (filePath === undefined) {
    throw new Error("Usage: redact.ts <digest.json>");
  }
  const raw = readFileSync(filePath, "utf-8");
  const digest = JSON.parse(raw) as EvidenceDigest;
  const items = flagEvidenceDigest(digest);
  return {
    digestId: digest.digestId,
    flaggedCount: items.filter((entry) => entry.flags.length > 0).length,
    items,
  };
};

const isMain = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
};

if (isMain()) {
  try {
    const result = runCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}
