import {
  previewCapabilitySchema,
  revisionArtifactManifestSchema,
  type PreviewCapability,
} from "@programmable-video/contracts";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const studioOrigin = configuredStudioOrigin(env.STUDIO_ORIGIN);
    if (!studioOrigin) return notFound();
    if (request.method === "GET" && url.pathname === "/launch") {
      return createLaunchResponse(
        request,
        env.PREVIEW_SIGNING_KEY,
        studioOrigin,
      );
    }

    const artifactMatch = /^\/artifact\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && artifactMatch) {
      const authorization = request.headers.get("authorization");
      const token = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : null;
      const capability =
        token && (await verifyCapability(token, env.PREVIEW_SIGNING_KEY));
      if (
        !capability ||
        capability.revisionId !== decodeURIComponent(artifactMatch[1]!)
      ) {
        return notFound();
      }
      const manifest = await env.REVISION_PREVIEWS.head(
        `${capability.prefix}/manifest.json`,
      );
      const artifact = await env.REVISION_PREVIEWS.get(
        `${capability.prefix}/artifact.tar.gz`,
      );
      if (
        !manifest ||
        manifest.customMetadata?.manifestDigest !== capability.manifestDigest ||
        !artifact ||
        artifact.customMetadata?.manifestDigest !== capability.manifestDigest
      )
        return notFound();
      return new Response(artifact.body, {
        headers: {
          "content-type": "application/gzip",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }

    const match = /^\/p\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (request.method !== "GET" || !match) return notFound();
    const token = cookie(request, "__Secure-pv_preview");
    const capability =
      token && (await verifyCapability(token, env.PREVIEW_SIGNING_KEY));
    if (!capability || capability.revisionId !== decodeURIComponent(match[1]!))
      return notFound();
    const path = decodeURIComponent(match[2]!);
    if (!safePath(path)) return notFound();

    const manifestObject = await env.REVISION_PREVIEWS.get(
      `${capability.prefix}/manifest.json`,
    );
    if (!manifestObject) return notFound();
    const manifestBytes = new Uint8Array(await manifestObject.arrayBuffer());
    if ((await sha256(manifestBytes)) !== capability.manifestDigest)
      return notFound();
    const parsed = revisionArtifactManifestSchema.safeParse(
      JSON.parse(new TextDecoder().decode(manifestBytes)),
    );
    if (
      !parsed.success ||
      parsed.data.projectId !== capability.projectId ||
      parsed.data.revisionId !== capability.revisionId ||
      parsed.data.commitSha !== capability.commitSha ||
      parsed.data.attempt !== capability.attempt
    )
      return notFound();
    const file = parsed.data.files.find((entry) => entry.path === path);
    if (!file) return notFound();
    const object = await env.REVISION_PREVIEWS.get(
      `${capability.prefix}/files/${path}`,
    );
    if (
      !object ||
      object.size !== file.size ||
      object.customMetadata?.digest !== file.digest
    )
      return notFound();
    return new Response(object.body, {
      headers: {
        "content-type": file.mediaType,
        "cache-control": "private, max-age=300, immutable",
        "content-security-policy": previewContentSecurityPolicy(studioOrigin),
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  },
} satisfies ExportedHandler<Env>;

export async function createLaunchResponse(
  request: Request,
  signingKey: string,
  studioOrigin: string,
): Promise<Response> {
  const configuredOrigin = configuredStudioOrigin(studioOrigin);
  if (!configuredOrigin) return notFound();
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const capability = token && (await verifyCapability(token, signingKey));
  if (!capability) return notFound();
  const destination = new URL(
    `/p/${capability.revisionId}/index.html`,
    url.origin,
  );
  destination.searchParams.set("parentOrigin", configuredOrigin);
  return new Response(null, {
    status: 302,
    headers: {
      location: destination.toString(),
      "set-cookie": `__Secure-pv_preview=${token}; Path=/p/${capability.revisionId}/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${Math.max(0, capability.expiresAt - Math.floor(Date.now() / 1000))}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

export function configuredStudioOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      url.hostname,
    );
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.origin !== value ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function previewContentSecurityPolicy(studioOrigin: string): string {
  return `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${studioOrigin}`;
}

async function verifyCapability(
  token: string,
  secret: string,
): Promise<PreviewCapability | null> {
  const [payload, encodedSignature, extra] = token.split(".");
  if (!payload || !encodedSignature || extra) return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      ownedArrayBuffer(decodeBase64Url(encodedSignature)),
      new TextEncoder().encode(payload),
    );
    if (!valid) return null;
    const parsed = previewCapabilitySchema.safeParse(
      JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))),
    );
    if (
      !parsed.success ||
      parsed.data.expiresAt < Math.floor(Date.now() / 1_000)
    ) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function safePath(path: string): boolean {
  return (
    Boolean(path) &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").includes("..")
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}
