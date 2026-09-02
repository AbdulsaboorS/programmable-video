export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export function errorMessage(error: BoundaryError): string {
  const parsed = boundaryErrorSchema.parse(error);
  return parsed instanceof Error ? parsed.message : String(parsed);
}

export function platformFailure(
  message: string,
  error: BoundaryError,
): Response {
  console.error(
    JSON.stringify({
      message,
      error: errorMessage(error),
    }),
  );
  return Response.json({ error: message }, { status: 502 });
}
import { z } from "zod";

const boundaryErrorSchema = z.unknown();

export type BoundaryError = z.input<typeof boundaryErrorSchema>;
