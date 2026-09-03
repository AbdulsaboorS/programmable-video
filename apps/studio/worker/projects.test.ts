import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createHandoff,
  createProjectFeedback,
  createProject,
  getProject,
  listProjects,
  saveProjectBrief,
  type ProjectApiEnv,
} from "./projects";

const owner = "creator@example.com";
const otherOwner = "other@example.com";
const projectId = "0198c7d4-a5e6-7000-8000-000000000000";
const requestId = "0198c7d4-a5e6-7000-8000-000000000100";

interface StoredProject {
  id: string;
  request_id: string | null;
  owner_email: string;
  name: string;
  status: "ready";
  source_host: string;
  source_project_path: string;
  source_web_url: string;
  source_default_branch: string;
  source_selected_ref: string;
  repository_name: string;
  repository_remote_url: string;
  repository_default_branch: string;
  repository_state: "seeded";
  authoring_source_kind: "artifacts" | "local";
  video_brief: string | null;
  video_brief_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

interface StoredReference {
  id: string;
  project_id: string;
  file_name: string;
  media_type: string;
  byte_size: number;
  note: string;
  storage_state: "metadata-only";
  created_at: string;
}

interface StoredHandoff {
  id: string;
  project_id: string;
  token_id: string;
  scope: "write";
  expires_at: string;
  created_at: string;
}

interface StoredAgentReference {
  id: string;
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

interface StoredFeedback {
  id: string;
  project_id: string;
  revision_id: string;
  frame: number;
  fps: number;
  duration_in_frames: 360 | 450;
  feedback: string;
  created_at: string;
}

class FakeDatabase {
  projects: StoredProject[] = [];
  references: StoredReference[] = [];
  agentReferences: StoredAgentReference[] = [];
  handoffs: StoredHandoff[] = [];
  feedback: StoredFeedback[] = [];
  revisionIds = new Set<string>();
  failProjectInsert = false;
  commitThenFailProjectInsert = false;
  failHandoffInsert = false;

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
    if (sql.startsWith("SELECT r.id, r.file_name")) {
      return this.agentReferences;
    }
    if (sql.startsWith("SELECT * FROM projects WHERE owner_email")) {
      return this.projects
        .filter((project) => project.owner_email === values[0])
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    }
    if (sql.startsWith("SELECT * FROM project_references")) {
      return this.references
        .filter((reference) => reference.project_id === values[0])
        .sort((left, right) => left.created_at.localeCompare(right.created_at));
    }
    if (sql.startsWith("SELECT * FROM project_feedback")) {
      return this.feedback
        .filter((feedback) => feedback.project_id === values[0])
        .sort((left, right) => left.created_at.localeCompare(right.created_at));
    }
    throw new Error(`Unexpected all query: ${sql}`);
  }

  private first(sql: string, values: unknown[]) {
    if (sql.startsWith("SELECT * FROM projects WHERE owner_email")) {
      return this.projects.find(
        (project) =>
          project.owner_email === values[0] && project.request_id === values[1],
      );
    }
    if (sql.startsWith("SELECT * FROM projects WHERE id")) {
      return this.projects.find(
        (project) =>
          project.id === values[0] && project.owner_email === values[1],
      );
    }
    if (sql.startsWith("SELECT r.id FROM project_revisions")) {
      return this.revisionIds.has(z.string().parse(values[0])) &&
        values[2] === 30 &&
        values[3] === 360
        ? { id: values[0] }
        : undefined;
    }
    if (sql.startsWith("SELECT * FROM project_feedback WHERE id")) {
      return this.feedback.find((feedback) => feedback.id === values[0]);
    }
    throw new Error(`Unexpected first query: ${sql}`);
  }

  private async run(sql: string, values: unknown[]) {
    if (sql.startsWith("INSERT INTO projects")) {
      if (this.failProjectInsert) throw new Error("project insert failed");
      const value = z
        .tuple([
          z.string(),
          z.string(),
          z.string(),
          z.string(),
          z.string(),
          z.string(),
          z.string(),
          z.string(),
          z.string(),
          z.string(),
          z.string(),
          z.string(),
          z.string(),
          z.string(),
        ])
        .parse(values);
      this.projects.push({
        id: value[0],
        owner_email: value[1],
        request_id: value[2],
        name: value[3],
        status: "ready",
        source_host: value[4],
        source_project_path: value[5],
        source_web_url: value[6],
        source_default_branch: value[7],
        source_selected_ref: value[8],
        repository_name: value[9],
        repository_remote_url: value[10],
        repository_default_branch: value[11],
        repository_state: "seeded",
        authoring_source_kind: "local",
        video_brief: null,
        video_brief_updated_at: null,
        created_at: value[12],
        updated_at: value[13],
      });
      if (this.commitThenFailProjectInsert) {
        throw new Error("ambiguous project insert failure");
      }
      return { success: true };
    }
    if (sql.startsWith("INSERT INTO project_references")) {
      const value = z
        .tuple([
          z.string(),
          z.string(),
          z.string(),
          z.string(),
          z.number(),
          z.string(),
          z.string(),
        ])
        .parse(values);
      this.references.push({
        id: value[0],
        project_id: value[1],
        file_name: value[2],
        media_type: value[3],
        byte_size: value[4],
        note: value[5],
        storage_state: "metadata-only",
        created_at: value[6],
      });
      return { success: true };
    }
    if (sql.startsWith("UPDATE projects SET video_brief")) {
      const project = this.projects.find(
        (candidate) =>
          candidate.id === values[3] && candidate.owner_email === values[4],
      );
      if (project) {
        const [brief, briefUpdatedAt, updatedAt] = z
          .tuple([z.string(), z.string(), z.string(), z.string(), z.string()])
          .parse(values);
        project.video_brief = brief;
        project.video_brief_updated_at = briefUpdatedAt;
        project.updated_at = updatedAt;
      }
      return { success: true };
    }
    if (sql.startsWith("INSERT INTO project_feedback")) {
      const value = z
        .tuple([
          z.string(),
          z.string(),
          z.string(),
          z.number(),
          z.number(),
          z.union([z.literal(360), z.literal(450)]),
          z.string(),
          z.string(),
        ])
        .parse(values);
      this.feedback.push({
        id: value[0],
        project_id: value[1],
        revision_id: value[2],
        frame: value[3],
        fps: value[4],
        duration_in_frames: value[5],
        feedback: value[6],
        created_at: value[7],
      });
      return { success: true };
    }
    if (sql.startsWith("INSERT INTO agent_handoffs")) {
      if (this.failHandoffInsert) throw new Error("handoff insert failed");
      const value = z
        .tuple([z.string(), z.string(), z.string(), z.string(), z.string()])
        .parse(values);
      this.handoffs.push({
        id: value[0],
        project_id: value[1],
        token_id: value[2],
        scope: "write",
        expires_at: value[3],
        created_at: value[4],
      });
      return { success: true };
    }
    throw new Error(`Unexpected run query: ${sql}`);
  }
}

function storedProject(overrides: Partial<StoredProject> = {}): StoredProject {
  return {
    id: projectId,
    request_id: requestId,
    owner_email: owner,
    name: "Product demo",
    status: "ready",
    source_host: "github.com",
    source_project_path: "team/product-demo",
    source_web_url: "https://github.com/team/product-demo",
    source_default_branch: "main",
    source_selected_ref: "main",
    repository_name: `video-${projectId}`,
    repository_remote_url: `https://artifacts.example/video-${projectId}.git`,
    repository_default_branch: "main",
    repository_state: "seeded",
    authoring_source_kind: "artifacts",
    video_brief: null,
    video_brief_updated_at: null,
    created_at: "2026-08-20T10:00:00.000Z",
    updated_at: "2026-08-20T10:00:00.000Z",
    ...overrides,
  };
}

function fakeArtifacts() {
  const revokeStarterToken = vi.fn(async () => true);
  const revokeProjectToken = vi.fn(async () => true);
  const tokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const createToken = vi.fn(async () => ({
    id: "token-id",
    plaintext: "temporary-token",
    scope: "write" as const,
    expiresAt: tokenExpiresAt,
  }));
  const fork = vi.fn(async (name: string) => ({
    id: "repo-id",
    name,
    description: "Product project starter",
    defaultBranch: "main",
    remote: `https://artifacts.example/${name}.git`,
    token: "initial-token",
    tokenExpiresAt: "2026-08-21T10:00:00.000Z",
  }));
  const starter = { fork, revokeToken: revokeStarterToken };
  const project = { createToken, revokeToken: revokeProjectToken };
  const get = vi.fn(async (name: string) =>
    name === "product-project-starter-v1" ? starter : project,
  );
  const remove = vi.fn(async () => true);
  return {
    binding: { get, delete: remove },
    createToken,
    fork,
    get,
    remove,
    revokeProjectToken,
    revokeStarterToken,
    tokenExpiresAt,
  };
}

function environment(database = new FakeDatabase()) {
  const artifacts = fakeArtifacts();
  return {
    database,
    artifacts,
    env: fromPartial<ProjectApiEnv>({
      ARTIFACTS: artifacts.binding,
      PREVIEW_SIGNING_KEY: "test-signing-key",
      PROJECTS_DB: fromPartial<D1Database>(database),
      PROJECT_REFERENCES: fromPartial<R2Bucket>({}),
      STARTER_REPOSITORY: "product-project-starter-v1",
      STUDIO_ORIGIN: "https://studio.example",
    }),
  };
}

function post(
  path: string,
  body: z.input<typeof z.json>,
  headers?: HeadersInit,
) {
  return new Request(`https://studio.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function body(response: Response) {
  return z.record(z.string(), z.json()).parse(await response.json());
}

describe("managed project API", () => {
  it("creates a local project without provisioning Artifacts", async () => {
    const { env, database, artifacts } = environment();
    const response = await createProject(
      post("/api/projects", {
        requestId,
        name: "  Product demo  ",
        githubUrl: "https://github.com/team/product-demo.git/",
        defaultBranch: "trunk",
      }),
      owner,
      env,
    );

    expect(response.status).toBe(201);
    expect(artifacts.get).not.toHaveBeenCalled();
    expect(artifacts.fork).not.toHaveBeenCalled();
    expect(database.projects[0]).toMatchObject({
      owner_email: owner,
      name: "Product demo",
      source_host: "github.com",
      source_project_path: "team/product-demo",
      source_web_url: "https://github.com/team/product-demo",
      source_default_branch: "trunk",
      repository_default_branch: "main",
      repository_state: "seeded",
      authoring_source_kind: "local",
    });
    expect(await body(response)).toMatchObject({
      name: "Product demo",
      source: { provider: "github" },
      repository: {
        kind: "local",
        state: "initialized",
        defaultBranch: "main",
      },
      references: [],
    });
  });

  it("rejects invalid requests before provisioning", async () => {
    const { env, artifacts } = environment();
    const response = await createProject(
      post("/api/projects", {
        requestId,
        name: "Product",
        githubUrl: "https://github.com/team/product",
        ownerEmail: otherOwner,
      }),
      owner,
      env,
    );

    expect(response.status).toBe(400);
    expect(artifacts.get).not.toHaveBeenCalled();
  });

  it("rejects oversized request bodies", async () => {
    const { env } = environment();
    const response = await createProject(
      post(
        "/api/projects",
        {
          requestId,
          name: "Product",
          githubUrl: "https://github.com/a/b",
        },
        { "content-length": String(1024 * 1024 + 1) },
      ),
      owner,
      env,
    );

    expect(response.status).toBe(413);
  });

  it("does not touch Artifacts when local project persistence fails", async () => {
    const database = new FakeDatabase();
    database.failProjectInsert = true;
    const { env, artifacts } = environment(database);
    const response = await createProject(
      post("/api/projects", {
        requestId,
        name: "Product",
        githubUrl: "https://github.com/team/product",
      }),
      owner,
      env,
    );

    expect(response.status).toBe(502);
    expect(artifacts.remove).not.toHaveBeenCalled();
  });

  it("returns the existing project for an idempotent retry", async () => {
    const { env, database, artifacts } = environment();
    database.projects.push(storedProject());
    const response = await createProject(
      post("/api/projects", {
        requestId,
        name: "Product demo",
        githubUrl: "https://github.com/team/product-demo",
      }),
      owner,
      env,
    );

    expect(response.status).toBe(200);
    expect(artifacts.fork).not.toHaveBeenCalled();
    expect(await body(response)).toMatchObject({ id: projectId });
  });

  it("rejects an idempotency key reused with different project input", async () => {
    const { env, database, artifacts } = environment();
    database.projects.push(storedProject());
    const response = await createProject(
      post("/api/projects", {
        requestId,
        name: "Different product",
        githubUrl: "https://github.com/team/different",
      }),
      owner,
      env,
    );

    expect(response.status).toBe(409);
    expect(artifacts.fork).not.toHaveBeenCalled();
  });

  it("keeps a repository when D1 committed before reporting failure", async () => {
    const database = new FakeDatabase();
    database.commitThenFailProjectInsert = true;
    const { env, artifacts } = environment(database);
    const response = await createProject(
      post("/api/projects", {
        requestId,
        name: "Product",
        githubUrl: "https://github.com/team/product",
      }),
      owner,
      env,
    );

    expect(response.status).toBe(200);
    expect(artifacts.remove).not.toHaveBeenCalled();
    expect(database.projects).toHaveLength(1);
  });

  it.each([
    "https://github.com/team%2Fother/product",
    "https://github.com/team/%E0%A4%A",
    "https://user:password@github.com/team/product",
    "https://gitlab.example.com/team/product",
    "https://github.com/team/nested/product",
  ])("rejects unsafe GitHub paths before provisioning", async (githubUrl) => {
    const { env, artifacts } = environment();
    const response = await createProject(
      post("/api/projects", { requestId, name: "Product", githubUrl }),
      owner,
      env,
    );

    expect(response.status).toBe(400);
    expect(artifacts.fork).not.toHaveBeenCalled();
  });

  it("does not depend on starter token revocation for local projects", async () => {
    const { env, artifacts, database } = environment();
    artifacts.revokeProjectToken.mockResolvedValueOnce(false);
    const response = await createProject(
      post("/api/projects", {
        requestId,
        name: "Product",
        githubUrl: "https://github.com/team/product",
      }),
      owner,
      env,
    );

    expect(response.status).toBe(201);
    expect(artifacts.remove).not.toHaveBeenCalled();
    expect(database.projects).toHaveLength(1);
  });

  it("lists and reads only the owner's projects", async () => {
    const { env, database } = environment();
    database.projects.push(
      storedProject(),
      storedProject({
        id: "0198c7d4-a5e6-7000-8000-000000000001",
        owner_email: otherOwner,
      }),
    );

    const listed = await listProjects(owner, env);
    expect(listed.status).toBe(200);
    expect((await body(listed)).projects).toHaveLength(1);
    expect((await getProject(projectId, owner, env)).status).toBe(200);
    expect((await getProject(projectId, otherOwner, env)).status).toBe(404);
    expect((await getProject("not-a-uuid", owner, env)).status).toBe(404);
  });

  it("preserves the provider label for existing GitLab projects", async () => {
    const { env, database } = environment();
    database.projects.push(
      storedProject({
        source_host: "gitlab.example.com",
        source_project_path: "team/legacy-product",
        source_web_url: "https://gitlab.example.com/team/legacy-product",
      }),
    );

    expect(await body(await getProject(projectId, owner, env))).toMatchObject({
      source: { provider: "gitlab", host: "gitlab.example.com" },
    });
  });

  it("returns a temporary handoff token without caching or persisting it", async () => {
    const { env, database, artifacts } = environment();
    database.projects.push(storedProject());

    const response = await createHandoff(projectId, owner, env);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(artifacts.createToken).toHaveBeenCalledWith("write", 3600);
    expect(await body(response)).toEqual({
      kind: "artifacts",
      remoteUrl: `https://artifacts.example/video-${projectId}.git`,
      token: "temporary-token",
      tokenExpiresAt: artifacts.tokenExpiresAt,
      defaultBranch: "main",
      references: [],
    });
    expect(database.handoffs[0]).toMatchObject({
      project_id: projectId,
      token_id: "token-id",
      scope: "write",
    });
    expect(JSON.stringify(database.handoffs)).not.toContain("temporary-token");
  });

  it("returns a local handoff without an Artifacts token or audit row", async () => {
    const { env, database, artifacts } = environment();
    database.projects.push(storedProject({ authoring_source_kind: "local" }));

    const response = await createHandoff(projectId, owner, env);

    expect(response.status).toBe(201);
    expect(await body(response)).toMatchObject({
      kind: "local",
      projectId,
      defaultBranch: "main",
      references: [],
    });
    expect(artifacts.createToken).not.toHaveBeenCalled();
    expect(database.handoffs).toHaveLength(0);
  });

  it.each([
    "not-a-timestamp",
    new Date(Date.now() - 1000).toISOString(),
    new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  ])("revokes a handoff token with invalid expiry %s", async (expiresAt) => {
    const { env, database, artifacts } = environment();
    database.projects.push(storedProject());
    artifacts.createToken.mockResolvedValueOnce({
      id: "invalid-token-id",
      plaintext: "invalid-token",
      scope: "write",
      expiresAt,
    });

    expect((await createHandoff(projectId, owner, env)).status).toBe(502);
    expect(artifacts.revokeProjectToken).toHaveBeenCalledWith(
      "invalid-token-id",
    );
    expect(database.handoffs).toHaveLength(0);
  });

  it("revokes the write token when reference handoff data is invalid", async () => {
    const { env, database, artifacts } = environment();
    database.projects.push(storedProject());
    database.agentReferences.push({
      id: "0198c7d4-a5e6-7000-8000-000000000010",
      file_name: "dashboard.png",
      media_type: "image/png",
      byte_size: 100,
      note: "Dashboard",
      object_key: `projects/${projectId}/references/ref/original.png`,
      sha256: "invalid",
      width: 1,
      height: 1,
      created_at: "2026-08-20T10:00:00.000Z",
    });

    const response = await createHandoff(projectId, owner, env);
    expect(response.status).toBe(502);
    expect(artifacts.revokeProjectToken).toHaveBeenCalledWith("token-id");
    expect(database.handoffs).toHaveLength(0);
  });

  it("persists the current brief and returns it with the project", async () => {
    const { env, database } = environment();
    database.projects.push(storedProject());

    expect(
      (
        await saveProjectBrief(
          post(`/api/projects/${projectId}/brief`, {
            text: "  Show the real product launch.  ",
          }),
          projectId,
          otherOwner,
          env,
        )
      ).status,
    ).toBe(404);
    const response = await saveProjectBrief(
      post(`/api/projects/${projectId}/brief`, {
        text: "  Show the real product launch.  ",
      }),
      projectId,
      owner,
      env,
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({
      text: "Show the real product launch.",
    });
    expect(await body(await getProject(projectId, owner, env))).toMatchObject({
      brief: { text: "Show the real product launch." },
    });
  });

  it("persists idempotent feedback only for an owned project revision", async () => {
    const revisionId = "0198c7d4-a5e6-7000-8000-000000000010";
    const feedbackId = "0198c7d4-a5e6-7000-8000-000000000011";
    const { env, database } = environment();
    database.projects.push(storedProject());
    database.revisionIds.add(revisionId);
    const request = () =>
      post(`/api/projects/${projectId}/feedback`, {
        id: feedbackId,
        revisionId,
        frame: 123,
        fps: 30,
        durationInFrames: 360,
        text: "  Match the source orb.  ",
      });

    expect(
      (await createProjectFeedback(request(), projectId, otherOwner, env))
        .status,
    ).toBe(404);
    expect(
      (
        await createProjectFeedback(
          post(`/api/projects/${projectId}/feedback`, {
            id: feedbackId,
            revisionId,
            frame: 123,
            fps: 30,
            durationInFrames: 450,
            text: "Match the source orb.",
          }),
          projectId,
          owner,
          env,
        )
      ).status,
    ).toBe(404);
    expect(
      (await createProjectFeedback(request(), projectId, owner, env)).status,
    ).toBe(201);
    expect(
      (await createProjectFeedback(request(), projectId, owner, env)).status,
    ).toBe(200);
    expect(database.feedback).toHaveLength(1);
    expect(await body(await getProject(projectId, owner, env))).toMatchObject({
      feedback: [
        {
          id: feedbackId,
          revisionId,
          frame: 123,
          fps: 30,
          durationInFrames: 360,
          text: "Match the source orb.",
        },
      ],
    });
    const conflictingRetry = await createProjectFeedback(
      post(`/api/projects/${projectId}/feedback`, {
        id: feedbackId,
        revisionId,
        frame: 124,
        fps: 30,
        durationInFrames: 360,
        text: "Different feedback",
      }),
      projectId,
      owner,
      env,
    );
    expect(conflictingRetry.status).toBe(409);
  });

  it("rejects feedback for a revision without a ready build", async () => {
    const { env, database } = environment();
    database.projects.push(storedProject());

    const response = await createProjectFeedback(
      post(`/api/projects/${projectId}/feedback`, {
        id: "0198c7d4-a5e6-7000-8000-000000000011",
        revisionId: "0198c7d4-a5e6-7000-8000-000000000010",
        frame: 123,
        fps: 30,
        durationInFrames: 360,
        text: "Match the source orb.",
      }),
      projectId,
      owner,
      env,
    );

    expect(response.status).toBe(404);
    expect(database.feedback).toHaveLength(0);
  });

  it("revokes a handoff token when audit persistence fails", async () => {
    const database = new FakeDatabase();
    database.projects.push(storedProject());
    database.failHandoffInsert = true;
    const { env, artifacts } = environment(database);

    const response = await createHandoff(projectId, owner, env);
    expect(response.status).toBe(502);
    expect(artifacts.revokeProjectToken).toHaveBeenCalledWith("token-id");
  });
});
