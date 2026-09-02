import { base64Url } from "./worker-utils";

export interface PreviewCapability {
  version: 1;
  projectId: string;
  revisionId: string;
  commitSha: string;
  attempt: number;
  prefix: string;
  manifestDigest: string;
  owner: string;
  expiresAt: number;
}

export async function signPreviewCapability(
  capability: PreviewCapability,
  secret: string,
): Promise<string> {
  const payload = base64Url(
    new TextEncoder().encode(JSON.stringify(capability)),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}
