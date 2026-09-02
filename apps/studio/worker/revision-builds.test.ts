import { DatabaseSync } from "node:sqlite";

import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  claimRevisionBuild,
  completeRevisionBuild,
  expireStaleRevisionBuild,
  listStaleRevisionBuilds,
  queueInitialRevisionBuild,
  queueRevisionBuildRetry,
  requestRevisionBuildRetry,
  revisionSandboxId,
} from "./revision-build-lifecycle";
import { parseRevisionVideoSpec } from "./revision-video-spec";

const schema = `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL
  );
  CREATE TABLE project_revisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    inspection_status TEXT NOT NULL
  );
  CREATE TABLE revision_builds (
    revision_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    check_results TEXT NOT NULL DEFAULT '[]',
    preview_prefix TEXT,
    manifest_digest TEXT,
    input_digest TEXT,
    fps INTEGER,
    duration_in_frames INTEGER,
    error_message TEXT,
    lease_owner TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

class TestDatabase {
  readonly sqlite = new DatabaseSync(":memory:");

  constructor() {
    this.sqlite.exec(schema);
  }

  prepare(query: string) {
    const statement = this.sqlite.prepare(query);
    return {
      bind: (...values: unknown[]) => ({
        first: async () => statement.get(...sqlValues.parse(values)) ?? null,
        all: async () => ({
          results: statement.all(...sqlValues.parse(values)),
          success: true,
          meta: {},
        }),
        run: async () => {
          const result = statement.run(...sqlValues.parse(values));
          return {
            success: true,
            meta: { changes: Number(result.changes) },
          };
        },
      }),
    };
  }

  asD1(): D1Database {
    return fromPartial<D1Database>(this);
  }

  addRevision(
    id: string,
    status: "queued" | "running" | "invalid" | "error" | "ready",
    updatedAt: string,
    attempt = 1,
    startedAt: string | null = null,
  ) {
    this.sqlite
      .prepare(
        `INSERT INTO revision_builds (
          revision_id, status, attempt, started_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, status, attempt, startedAt, updatedAt, updatedAt);
  }

  status(id: string): { status: string; attempt: number } {
    return z
      .object({ status: z.string(), attempt: z.number() })
      .parse(
        this.sqlite
          .prepare(
            "SELECT status, attempt FROM revision_builds WHERE revision_id = ?",
          )
          .get(id),
      );
  }
}

const sqlValues = z.array(
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.bigint(),
    z.instanceof(Uint8Array),
  ]),
);

interface WorkflowBatchOption {
  id: string;
  params: {
    kind: "retry-build";
    projectId: string;
    revisionId: string;
    attempt: number;
  };
}

function workflowBinding(
  createBatch: (options: WorkflowBatchOption[]) => Promise<void | never[]>,
) {
  return {
    createBatch,
    get: async () => ({
      status: async () => ({ status: "running" }),
      restart: async () => undefined,
    }),
  };
}

describe("revision builds", () => {
  it("accepts only a supported emitted video specification", () => {
    expect(
      parseRevisionVideoSpec(
        new TextEncoder().encode(
          JSON.stringify({
            width: 1280,
            height: 720,
            fps: 30,
            durationInFrames: 360,
          }),
        ),
      ),
    ).toEqual({ width: 1280, height: 720, fps: 30, durationInFrames: 360 });
    expect(() =>
      parseRevisionVideoSpec(
        new TextEncoder().encode(
          JSON.stringify({
            width: 1280,
            height: 720,
            fps: 60,
            durationInFrames: 360,
          }),
        ),
      ),
    ).toThrow();
  });

  it("derives distinct Sandbox ids from build attempts", () => {
    expect(revisionSandboxId("revision-1", 1)).toBe(
      "revision-revision-1-attempt-1",
    );
    expect(revisionSandboxId("revision-1", 2)).not.toBe(
      revisionSandboxId("revision-1", 1),
    );
  });

  it("queues the initial build idempotently", async () => {
    const database = new TestDatabase();
    const now = new Date("2026-08-25T10:00:00.000Z");

    await expect(
      queueInitialRevisionBuild("revision-1", database.asD1(), now),
    ).resolves.toEqual({ attempt: 1 });
    await expect(
      queueInitialRevisionBuild("revision-1", database.asD1(), now),
    ).resolves.toEqual({ attempt: 1 });
  });

  it("admits at most two builds", async () => {
    const database = new TestDatabase();
    database.addRevision("revision-1", "queued", "2026-08-25T10:00:00.000Z");
    database.addRevision("revision-2", "queued", "2026-08-25T10:00:01.000Z");
    database.addRevision("revision-3", "queued", "2026-08-25T10:00:02.000Z");
    const now = new Date("2026-08-25T10:01:00.000Z");

    await expect(
      claimRevisionBuild("revision-1", 1, "workflow-1", database.asD1(), now),
    ).resolves.toEqual({
      kind: "claimed",
      attempt: 1,
      createdAt: "2026-08-25T10:00:00.000Z",
    });
    await expect(
      claimRevisionBuild("revision-2", 1, "workflow-2", database.asD1(), now),
    ).resolves.toEqual({
      kind: "claimed",
      attempt: 1,
      createdAt: "2026-08-25T10:00:01.000Z",
    });
    await expect(
      claimRevisionBuild("revision-3", 1, "workflow-3", database.asD1(), now),
    ).resolves.toEqual({ kind: "waiting" });
  });

  it("replays a claim idempotently for its Workflow lease", async () => {
    const database = new TestDatabase();
    database.addRevision("revision-1", "queued", "2026-08-25T10:00:00.000Z");
    const now = new Date("2026-08-25T10:01:00.000Z");

    const first = await claimRevisionBuild(
      "revision-1",
      1,
      "workflow-1",
      database.asD1(),
      now,
    );
    await expect(
      claimRevisionBuild("revision-1", 1, "workflow-1", database.asD1(), now),
    ).resolves.toEqual(first);
    await expect(
      claimRevisionBuild(
        "revision-1",
        1,
        "other-workflow",
        database.asD1(),
        now,
      ),
    ).resolves.toEqual({ kind: "unavailable" });
  });

  it("expires a stale build only after its Sandbox can be cleaned up", async () => {
    const database = new TestDatabase();
    database.addRevision(
      "stale",
      "running",
      "2026-08-25T09:00:00.000Z",
      1,
      "2026-08-25T09:00:00.000Z",
    );
    database.sqlite
      .prepare(
        "UPDATE revision_builds SET lease_owner = 'workflow-stale' WHERE revision_id = 'stale'",
      )
      .run();
    database.addRevision("next", "queued", "2026-08-25T10:00:00.000Z");
    const now = new Date("2026-08-25T10:01:00.000Z");

    const stale = await listStaleRevisionBuilds(database.asD1(), now);
    expect(stale).toEqual([
      { revisionId: "stale", attempt: 1, leaseOwner: "workflow-stale" },
    ]);
    await expect(
      expireStaleRevisionBuild(stale[0]!, database.asD1(), now),
    ).resolves.toBe(true);
    expect(database.status("stale").status).toBe("error");
  });

  it("retries only an owned platform error and increments its attempt", async () => {
    const database = new TestDatabase();
    database.sqlite.exec(`
      INSERT INTO projects VALUES ('project-1', 'owner@example.com');
      INSERT INTO projects VALUES ('project-2', 'owner@example.com');
      INSERT INTO project_revisions VALUES ('revision-1', 'project-1', 'valid');
      INSERT INTO project_revisions VALUES ('revision-2', 'project-2', 'valid');
    `);
    database.addRevision("revision-1", "error", "2026-08-25T10:00:00.000Z");
    database.addRevision("revision-2", "error", "2026-08-25T10:00:00.000Z");

    await expect(
      queueRevisionBuildRetry(
        "project-1",
        "revision-1",
        "other@example.com",
        database.asD1(),
      ),
    ).resolves.toEqual({ kind: "not-found" });
    await expect(
      queueRevisionBuildRetry(
        "project-1",
        "revision-2",
        "owner@example.com",
        database.asD1(),
      ),
    ).resolves.toEqual({ kind: "not-found" });
    await expect(
      queueRevisionBuildRetry(
        "project-1",
        "revision-1",
        "owner@example.com",
        database.asD1(),
      ),
    ).resolves.toEqual({ kind: "queued", attempt: 2 });
    await expect(
      queueRevisionBuildRetry(
        "project-1",
        "revision-1",
        "owner@example.com",
        database.asD1(),
      ),
    ).resolves.toEqual({ kind: "already-queued", attempt: 2 });
  });

  it("does not let an old attempt overwrite a newer build", async () => {
    const database = new TestDatabase();
    database.addRevision(
      "revision-1",
      "running",
      "2026-08-25T10:00:00.000Z",
      2,
      "2026-08-25T10:00:00.000Z",
    );

    await expect(
      completeRevisionBuild(
        "revision-1",
        1,
        "old-workflow",
        "error",
        [],
        { errorMessage: "stale" },
        database.asD1(),
      ),
    ).resolves.toBe(false);
    expect(database.status("revision-1")).toEqual({
      status: "running",
      attempt: 2,
    });
  });

  it("starts an owner-scoped retry Workflow with a deterministic id", async () => {
    const database = new TestDatabase();
    database.sqlite.exec(`
      INSERT INTO projects VALUES ('project-1', 'owner@example.com');
      INSERT INTO project_revisions VALUES ('revision-1', 'project-1', 'valid');
    `);
    database.addRevision("revision-1", "error", "2026-08-25T10:00:00.000Z");
    const created: unknown[] = [];

    const response = await requestRevisionBuildRetry(
      new Request("https://studio.example/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
      "project-1",
      "revision-1",
      "owner@example.com",
      {
        PROJECTS_DB: database.asD1(),
        REVISION_WORKFLOW: workflowBinding(async (options) => {
          created.push(...options);
        }),
      },
    );

    expect(response.status).toBe(202);
    expect(created).toEqual([
      {
        id: "revision-revision-1-attempt-2",
        params: {
          kind: "retry-build",
          projectId: "project-1",
          revisionId: "revision-1",
          attempt: 2,
        },
      },
    ]);
  });

  it("reconciles a queued retry after Workflow dispatch fails", async () => {
    const database = new TestDatabase();
    database.sqlite.exec(`
      INSERT INTO projects VALUES ('project-1', 'owner@example.com');
      INSERT INTO project_revisions VALUES ('revision-1', 'project-1', 'valid');
    `);
    database.addRevision("revision-1", "error", "2026-08-25T10:00:00.000Z");
    let fail = true;
    const createBatch = async () => {
      if (fail) throw new Error("dispatch unavailable");
    };
    const request = () =>
      new Request("https://studio.example/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });

    const first = await requestRevisionBuildRetry(
      request(),
      "project-1",
      "revision-1",
      "owner@example.com",
      {
        PROJECTS_DB: database.asD1(),
        REVISION_WORKFLOW: workflowBinding(createBatch),
      },
    );
    expect(first.status).toBe(503);
    expect(database.status("revision-1")).toEqual({
      status: "queued",
      attempt: 2,
    });

    fail = false;
    const second = await requestRevisionBuildRetry(
      request(),
      "project-1",
      "revision-1",
      "owner@example.com",
      {
        PROJECTS_DB: database.asD1(),
        REVISION_WORKFLOW: workflowBinding(createBatch),
      },
    );
    expect(second.status).toBe(202);
  });

  it("rejects form posts before changing retry state", async () => {
    const database = new TestDatabase();
    const createBatch = async () => [];

    const response = await requestRevisionBuildRetry(
      new Request("https://studio.example/retry", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      "project-1",
      "revision-1",
      "owner@example.com",
      {
        PROJECTS_DB: database.asD1(),
        REVISION_WORKFLOW: workflowBinding(createBatch),
      },
    );

    expect(response.status).toBe(415);
  });

  it("restarts a retained terminal retry Workflow", async () => {
    const database = new TestDatabase();
    database.sqlite.exec(`
      INSERT INTO projects VALUES ('project-1', 'owner@example.com');
      INSERT INTO project_revisions VALUES ('revision-1', 'project-1', 'valid');
    `);
    database.addRevision("revision-1", "queued", "2026-08-25T10:00:00.000Z", 2);
    let restarted = false;

    const response = await requestRevisionBuildRetry(
      new Request("https://studio.example/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
      "project-1",
      "revision-1",
      "owner@example.com",
      {
        PROJECTS_DB: database.asD1(),
        REVISION_WORKFLOW: {
          createBatch: async () => [],
          get: async () => ({
            status: async () => ({ status: "errored" }),
            restart: async () => {
              restarted = true;
            },
          }),
        },
      },
    );

    expect(response.status).toBe(202);
    expect(restarted).toBe(true);
  });
});
