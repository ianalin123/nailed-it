import { existsSync, readFileSync } from "node:fs";
import type { ZodError, ZodType, ZodTypeDef } from "zod";

export const describeZodError = (label: string, error: ZodError): string => {
  const lines = error.issues.map((issue) => `  ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`);
  return `${label} is invalid:\n${lines.join("\n")}`;
};

export const parseWith = <T>(schema: ZodType<T, ZodTypeDef, unknown>, raw: unknown, label: string): T => {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(describeZodError(label, parsed.error));
  return parsed.data;
};

export const readJsonFile = (path: string, label: string): unknown => {
  if (!existsSync(path)) throw new Error(`${label} not found at ${path}`);
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} at ${path} is not valid JSON: ${reason}`);
  }
};
