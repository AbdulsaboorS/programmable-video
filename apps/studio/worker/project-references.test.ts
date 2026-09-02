import { describe, expect, it, vi } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import {
  referenceImageMaxBytes,
  referenceImageMaxDimension,
} from "@programmable-video/contracts";
import { z } from "zod";

import {
  createAgentReferenceDownloads,
  createReferenceUpload,
  getReferenceByCapability,
  getReferenceContent,
  type AgentReferenceEnv,
  type ProjectReferenceEnv,
} from "./project-references";
import { multipartOverheadBytes } from "./worker-constants";

const projectId = "0198c7d4-a5e6-7000-8000-000000000000";
const owner = "creator@example.com";
const otherOwner = "other@example.com";

interface StoredReference {
  id: string;
  project_id: string;
  file_name: string;
  media_type: "image/png";
  byte_size: number;
  note: string;
  object_key: string;
  sha256: string;
  width: number;
  height: number;
  created_at: string;
}

class FakeDatabase {
  projects = new Map([[projectId, owner]]);
  references: StoredReference[] = [];
  failInsert = false;

  prepare(query: string) {
    const sql = query.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async () => ({ results: this.all(sql, values) }),
        first: async () => this.first(sql, values) ?? null,
        run: async () => this.run(sql, values),
      }),
    };
  }

  private all(sql: string, values: unknown[]) {
    if (sql.includes("WHERE r.project_id = ?")) {
      return this.projects.get(z.string().parse(values[0])) === values[1]
        ? this.references.filter(
            (reference) => reference.project_id === values[0],
          )
        : [];
    }
    throw new Error(`Unexpected all query: ${sql}`);
  }

  private first(sql: string, values: unknown[]) {
    if (sql.startsWith("SELECT id FROM projects")) {
      return this.projects.get(z.string().parse(values[0])) === values[1]
        ? { id: values[0] }
        : undefined;
    }
    if (sql.startsWith("SELECT r.id")) {
      const reference = this.references.find(
        (candidate) =>
          candidate.id === values[0] && candidate.project_id === values[1],
      );
      return reference && this.projects.get(reference.project_id) === values[2]
        ? reference
        : undefined;
    }
    if (sql.startsWith("SELECT id, file_name")) {
      return this.references.find(
        (reference) =>
          reference.id === values[0] &&
          reference.project_id === values[1] &&
          reference.object_key === values[2] &&
          reference.sha256 === values[3] &&
          reference.byte_size === values[4] &&
          reference.media_type === values[5],
      );
    }
    throw new Error(`Unexpected first query: ${sql}`);
  }

  private async run(sql: string, values: unknown[]) {
    if (!sql.startsWith("INSERT INTO project_references")) {
      throw new Error(`Unexpected run query: ${sql}`);
    }
    if (this.failInsert) throw new Error("D1 insert failed");
    const value = z
      .tuple([
        z.string(),
        z.string(),
        z.string(),
        z.number(),
        z.string(),
        z.string(),
        z.string(),
        z.number(),
        z.number(),
        z.string(),
      ])
      .parse(values);
    this.references.push({
      id: value[0],
      project_id: value[1],
      file_name: value[2],
      media_type: "image/png",
      byte_size: value[3],
      note: value[4],
      object_key: value[5],
      sha256: value[6],
      width: value[7],
      height: value[8],
      created_at: value[9],
    });
    return { success: true };
  }
}

class FakeBucket {
  objects = new Map<
    string,
    {
      bytes: Uint8Array;
      httpMetadata: R2HTTPMetadata;
      customMetadata: Record<string, string>;
    }
  >();
  put = vi.fn(
    async (
      key: string,
      value: Uint8Array,
      options: {
        httpMetadata: R2HTTPMetadata;
        customMetadata: Record<string, string>;
      },
    ) => {
      this.objects.set(key, {
        bytes: new Uint8Array(value),
        httpMetadata: options.httpMetadata,
        customMetadata: options.customMetadata,
      });
      return { key, size: value.byteLength };
    },
  );
  get = vi.fn(async (key: string) => {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: new Blob([ownedBuffer(object.bytes)]).stream(),
      size: object.bytes.byteLength,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
    };
  });
  delete = vi.fn(async (key: string) => {
    this.objects.delete(key);
  });
}

function environment(database = new FakeDatabase()) {
  const bucket = new FakeBucket();
  return {
    database,
    bucket,
    env: {
      PROJECTS_DB: fromPartial<D1Database>(database),
      PROJECT_REFERENCES: fromPartial<R2Bucket>(bucket),
    } satisfies ProjectReferenceEnv,
  };
}

function agentEnvironment(database = new FakeDatabase()) {
  const base = environment(database);
  return {
    ...base,
    env: {
      ...base.env,
      PREVIEW_SIGNING_KEY: "test-signing-key",
      STUDIO_ORIGIN: "https://studio.example",
    } satisfies AgentReferenceEnv,
  };
}

function png(width = 1, height = 1): Uint8Array {
  const valid = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  if (width === 1 && height === 1) return valid;
  const changed = new Uint8Array(valid);
  const view = new DataView(changed.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return changed;
}

function uploadRequest(bytes = png(), type = "image/png"): Request {
  const form = new FormData();
  form.set("file", new File([ownedBuffer(bytes)], "dashboard.png", { type }));
  form.set("representedState", "  Dashboard after login  ");
  return new Request(
    `https://studio.example/api/projects/${projectId}/references`,
    {
      method: "POST",
      body: form,
    },
  );
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

describe("project reference images", () => {
  it("validates, stores, and records an owned PNG", async () => {
    const { env, database, bucket } = environment();
    const response = await createReferenceUpload(
      uploadRequest(),
      projectId,
      owner,
      env,
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      fileName: "dashboard.png",
      note: "Dashboard after login",
      storageState: "uploaded",
      width: 1,
      height: 1,
    });
    expect(database.references).toHaveLength(1);
    expect(database.references[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bucket.put).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^projects/${projectId}/references/.+/original\\.png$`),
      ),
      expect.any(Uint8Array),
      expect.objectContaining({
        httpMetadata: { contentType: "image/png" },
        customMetadata: expect.objectContaining({ projectId }),
      }),
    );
  });

  it("checks ownership before reading or storing upload data", async () => {
    const { env, bucket } = environment();
    const response = await createReferenceUpload(
      uploadRequest(),
      projectId,
      otherOwner,
      env,
    );
    expect(response.status).toBe(404);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("bounds a lengthless request before multipart parsing", async () => {
    const { env, bucket } = environment();
    const request = new Request(
      `https://studio.example/api/projects/${projectId}/references`,
      {
        method: "POST",
        body: new Uint8Array(
          referenceImageMaxBytes + multipartOverheadBytes + 1,
        ),
      },
    );
    expect(request.headers.get("content-length")).toBeNull();
    const response = await createReferenceUpload(
      request,
      projectId,
      owner,
      env,
    );
    expect(response.status).toBe(413);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it.each([
    [new Uint8Array(), "image/png"],
    [new TextEncoder().encode("not png"), "image/png"],
    [png(), "image/jpeg"],
    [png(referenceImageMaxDimension + 1, 720), "image/png"],
    [png().slice(0, -12), "image/png"],
    [
      Uint8Array.from(png(), (byte, index) => (index === 30 ? byte ^ 1 : byte)),
      "image/png",
    ],
  ])("rejects invalid image bytes and dimensions", async (bytes, type) => {
    const { env, bucket } = environment();
    const response = await createReferenceUpload(
      uploadRequest(bytes, type),
      projectId,
      owner,
      env,
    );
    expect(response.status).toBe(400);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("removes the R2 object when D1 persistence fails", async () => {
    const database = new FakeDatabase();
    database.failInsert = true;
    const { env, bucket } = environment(database);
    const response = await createReferenceUpload(
      uploadRequest(),
      projectId,
      owner,
      env,
    );
    expect(response.status).toBe(502);
    expect(bucket.delete).toHaveBeenCalledOnce();
    expect(bucket.objects.size).toBe(0);
  });

  it("serves exact bytes only to the owning project user", async () => {
    const { env } = environment();
    const uploaded = await createReferenceUpload(
      uploadRequest(),
      projectId,
      owner,
      env,
    );
    const reference = z.object({ id: z.string() }).parse(await uploaded.json());

    const response = await getReferenceContent(
      projectId,
      reference.id,
      owner,
      env,
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png());
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(
      (await getReferenceContent(projectId, reference.id, otherOwner, env))
        .status,
    ).toBe(404);
    expect(
      (
        await getReferenceContent(
          "0198c7d4-a5e6-7000-8000-000000000001",
          reference.id,
          owner,
          env,
        )
      ).status,
    ).toBe(404);
  });

  it("issues digest-bound agent downloads and rejects invalid capabilities", async () => {
    const { env } = agentEnvironment();
    const uploaded = await createReferenceUpload(
      uploadRequest(),
      projectId,
      owner,
      env,
    );
    const reference = z.object({ id: z.string() }).parse(await uploaded.json());
    const [download] = await createAgentReferenceDownloads(
      projectId,
      owner,
      "2099-08-20T11:00:00.000Z",
      env,
    );

    expect(download).toMatchObject({
      id: reference.id,
      fileName: "dashboard.png",
      downloadUrl: `https://studio.example/api/internal/project-references/${reference.id}`,
    });
    expect(download?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const response = await getReferenceByCapability(
      reference.id,
      download!.token,
      env,
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png());
    expect(
      (
        await getReferenceByCapability(
          "0198c7d4-a5e6-7000-8000-000000000001",
          download!.token,
          env,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await getReferenceByCapability(
          reference.id,
          `${download!.token[0] === "A" ? "B" : "A"}${download!.token.slice(1)}`,
          env,
        )
      ).status,
    ).toBe(404);
  });

  it("rejects a configured Studio URL that is not an HTTPS origin", async () => {
    const { env } = agentEnvironment();

    await expect(
      createAgentReferenceDownloads(
        projectId,
        owner,
        "2099-08-20T11:00:00.000Z",
        {
          ...env,
          STUDIO_ORIGIN: "https://studio.example/private",
        },
      ),
    ).rejects.toThrow("STUDIO_ORIGIN must be an HTTPS origin");
  });

  it("rejects expired agent reference downloads", async () => {
    const { env } = agentEnvironment();
    const uploaded = await createReferenceUpload(
      uploadRequest(),
      projectId,
      owner,
      env,
    );
    const reference = z.object({ id: z.string() }).parse(await uploaded.json());
    const [download] = await createAgentReferenceDownloads(
      projectId,
      owner,
      "2020-08-20T11:00:00.000Z",
      env,
    );
    expect(
      (await getReferenceByCapability(reference.id, download!.token, env))
        .status,
    ).toBe(404);
  });

  it("rejects an R2 object assigned to another project", async () => {
    const { env, bucket } = agentEnvironment();
    const uploaded = await createReferenceUpload(
      uploadRequest(),
      projectId,
      owner,
      env,
    );
    const reference = z.object({ id: z.string() }).parse(await uploaded.json());
    const object = [...bucket.objects.values()][0];
    if (!object) throw new Error("Expected stored reference");
    object.customMetadata.projectId = "0198c7d4-a5e6-7000-8000-000000000001";

    expect(
      (await getReferenceContent(projectId, reference.id, owner, env)).status,
    ).toBe(404);
  });
});
