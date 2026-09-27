import type { VerdictRecord } from "@nailed-it/protocol";

export const EXPORT_KEY_HEADER = "x-export-key";

const constantTimeEquals = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < right.length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
};

export const isExportAuthorized = (provided: string | null, expected: string | undefined): boolean =>
  expected !== undefined && expected.length > 0 && provided !== null && constantTimeEquals(provided, expected);

export const toJsonl = (records: readonly VerdictRecord[]): string =>
  records.map((record) => `${JSON.stringify(record)}\n`).join("");

export const handleExportRequest = async (
  request: Request,
  expectedKey: string | undefined,
  loadVerdicts: () => Promise<readonly VerdictRecord[]>,
): Promise<Response> => {
  if (!isExportAuthorized(request.headers.get(EXPORT_KEY_HEADER), expectedKey)) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
  }
  return new Response(toJsonl(await loadVerdicts()), {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
};
