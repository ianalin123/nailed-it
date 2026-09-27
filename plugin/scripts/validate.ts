// Validates an EvidenceDigest or Deck JSON file against the shared protocol
// schemas from @nailed-it/protocol, printing precise per-field errors.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { z } from "zod";
import { Deck, EvidenceDigest } from "@nailed-it/protocol";

export type ValidationKind = "digest" | "deck";

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  kind: ValidationKind;
  errors: ValidationError[];
}

/** Infers digest vs. deck from shape: a deck has `reads`, a digest has `items`. */
export const detectKind = (data: unknown): ValidationKind | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  if ("reads" in data) return "deck";
  if ("items" in data) return "digest";
  return undefined;
};

export const formatZodErrors = (error: z.ZodError): ValidationError[] =>
  error.issues.map((issue: z.ZodIssue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));

export const validateData = (data: unknown, kind?: ValidationKind): ValidationResult => {
  const resolvedKind = kind ?? detectKind(data);
  if (resolvedKind === undefined) {
    return {
      valid: false,
      kind: "digest",
      errors: [
        {
          path: "(root)",
          message: 'Could not tell digest from deck: expected an "items" or "reads" field.',
        },
      ],
    };
  }
  const schema = resolvedKind === "deck" ? Deck : EvidenceDigest;
  const result = schema.safeParse(data);
  if (result.success) {
    return { valid: true, kind: resolvedKind, errors: [] };
  }
  return { valid: false, kind: resolvedKind, errors: formatZodErrors(result.error) };
};

export const validateJsonText = (text: string, kind?: ValidationKind): ValidationResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      valid: false,
      kind: kind ?? "digest",
      errors: [{ path: "(root)", message: `Invalid JSON: ${(error as Error).message}` }],
    };
  }
  return validateData(parsed, kind);
};

export const validateFile = (filePath: string, kind?: ValidationKind): ValidationResult => {
  const text = readFileSync(filePath, "utf-8");
  return validateJsonText(text, kind);
};

const formatResult = (filePath: string, result: ValidationResult): string => {
  if (result.valid) {
    return `${filePath}: valid ${result.kind}`;
  }
  const lines = result.errors.map((error) => `  ${error.path}: ${error.message}`);
  return [`${filePath}: invalid ${result.kind}`, ...lines].join("\n");
};

interface ParsedArgs {
  filePath: string;
  kind: ValidationKind | undefined;
}

export const parseArgs = (argv: string[]): ParsedArgs => {
  const positional: string[] = [];
  let kind: ValidationKind | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--type") {
      const value = argv[i + 1];
      if (value !== "digest" && value !== "deck") {
        throw new Error('--type must be "digest" or "deck"');
      }
      kind = value;
      i += 1;
    } else {
      positional.push(arg as string);
    }
  }
  const filePath = positional[0];
  if (filePath === undefined) {
    throw new Error("Usage: validate.ts <file> [--type digest|deck]");
  }
  return { filePath, kind };
};

const isMain = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
};

if (isMain()) {
  try {
    const { filePath, kind } = parseArgs(process.argv.slice(2));
    const result = validateFile(filePath, kind);
    process.stdout.write(`${formatResult(filePath, result)}\n`);
    process.exit(result.valid ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}
