import { previewCapabilitySchema } from "@programmable-video/contracts";
import { describe, expect, it } from "vitest";

import { signPreviewCapability } from "../studio/worker/preview-capability";
import {
  configuredStudioOrigin,
  createLaunchResponse,
  previewContentSecurityPolicy,
} from "./worker";

const signingKey = "preview-worker-test-signing-key";

function validCapability(expiresAt: number) {
  return previewCapabilitySchema.parse({
    version: 1,
    projectId: "0198c7d4-a5e6-7000-8000-000000000001",
    revisionId: "0198c7d4-a5e6-7000-8000-000000000002",
    commitSha: "a".repeat(40),
    attempt: 1,
    prefix: "previews/project/commit/attempt-1",
    manifestDigest: "b".repeat(64),
    owner: "creator@example.com",
    expiresAt,
  });
}

async function signPayload<Payload extends object>(
  payload: Payload,
): Promise<string> {
  const encodedPayload = btoa(JSON.stringify(payload))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(encodedPayload),
    ),
  );
  const encodedSignature = btoa(String.fromCharCode(...signature))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `${encodedPayload}.${encodedSignature}`;
}

async function launchToken(expiresAt: number): Promise<string> {
  return signPreviewCapability(validCapability(expiresAt), signingKey);
}

describe("isolated preview Worker", () => {
  it("sets a short-lived partitioned cookie for an embedded launch", async () => {
    const token = await launchToken(Math.floor(Date.now() / 1_000) + 300);
    const response = await createLaunchResponse(
      new Request(`https://preview.example/launch?token=${token}`),
      signingKey,
      "https://studio.example",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "/p/0198c7d4-a5e6-7000-8000-000000000002/index.html",
    );
    expect(response.headers.get("location")).toContain(
      "parentOrigin=https%3A%2F%2Fstudio.example",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "__Secure-pv_preview=",
    );
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("SameSite=None");
    expect(response.headers.get("set-cookie")).toContain("Partitioned");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("returns the same safe 404 for invalid and expired capabilities", async () => {
    const expired = await launchToken(Math.floor(Date.now() / 1_000) - 1);
    const invalidResponse = await createLaunchResponse(
      new Request("https://preview.example/launch?token=invalid"),
      signingKey,
      "https://studio.example",
    );
    const expiredResponse = await createLaunchResponse(
      new Request(`https://preview.example/launch?token=${expired}`),
      signingKey,
      "https://studio.example",
    );

    expect(invalidResponse.status).toBe(404);
    expect(expiredResponse.status).toBe(404);
  });

  it.each([
    ["missing fields", (expiresAt: number) => ({ version: 1, expiresAt })],
    [
      "extra fields",
      (expiresAt: number) => ({
        ...validCapability(expiresAt),
        unexpected: true,
      }),
    ],
    [
      "an invalid attempt",
      (expiresAt: number) => ({
        ...validCapability(expiresAt),
        attempt: 0,
      }),
    ],
    [
      "wrong field types",
      (expiresAt: number) => ({
        ...validCapability(expiresAt),
        revisionId: 42,
      }),
    ],
  ])(
    "rejects validly signed payloads with %s",
    async (_description, payload) => {
      const token = await signPayload(
        payload(Math.floor(Date.now() / 1_000) + 300),
      );
      const response = await createLaunchResponse(
        new Request(`https://preview.example/launch?token=${token}`),
        signingKey,
        "https://studio.example",
      );

      expect(response.status).toBe(404);
    },
  );

  it("requires an exact secure Studio origin", async () => {
    expect(configuredStudioOrigin("https://studio.example")).toBe(
      "https://studio.example",
    );
    expect(configuredStudioOrigin("http://studio.example")).toBeNull();
    expect(configuredStudioOrigin("https://studio.example/path")).toBeNull();
    expect(configuredStudioOrigin("https://studio.example/")).toBeNull();

    const token = await launchToken(Math.floor(Date.now() / 1_000) + 300);
    const response = await createLaunchResponse(
      new Request(`https://preview.example/launch?token=${token}`),
      signingKey,
      "https://studio.example/path",
    );
    expect(response.status).toBe(404);
  });

  it("allows only the configured Studio origin to frame static files", () => {
    const policy = previewContentSecurityPolicy("https://studio.example");

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("frame-ancestors https://studio.example");
  });
});
