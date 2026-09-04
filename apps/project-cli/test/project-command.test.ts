import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  projectConfigPath,
  projectStarterDirectory,
  runProjectCommand,
} from "../src/project-command";

const execFileAsync = promisify(execFile);
const projectId = "123e4567-e89b-42d3-a456-426614174000";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      }),
    ),
  );
});

describe("project command", () => {
  it("initializes main from the starter and keeps project configuration uncommitted", async () => {
    const parent = await temporaryDirectory();
    const destination = join(parent, "product-video");
    const starterPackage = await readFile(
      join(projectStarterDirectory, "package.json"),
      "utf8",
    );
    const command = harness();

    expect(
      await command.run(["init", destination, "--project", projectId]),
    ).toBe(0);

    expect(await git(destination, ["branch", "--show-current"])).toBe("main");
    expect(await git(destination, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(destination, ["status", "--porcelain=v1"])).toBe("");
    expect(await readFile(join(destination, "package.json"), "utf8")).toBe(
      starterPackage,
    );
    expect(
      JSON.parse(
        await readFile(join(destination, ".git", projectConfigPath), "utf8"),
      ),
    ).toEqual({
      version: 1,
      projectId,
      studioOrigin: "http://localhost:5173",
    });
    expect(await git(destination, ["ls-files", projectConfigPath])).toBe("");
    expect(
      await readFile(join(projectStarterDirectory, "package.json"), "utf8"),
    ).toBe(starterPackage);
  });

  it("rejects a destination inside an existing Git worktree", async () => {
    const parent = await temporaryDirectory();
    await git(parent, ["init", "-b", "main"]);
    const command = harness();

    expect(
      await command.run([
        "init",
        join(parent, "product-video"),
        "--project",
        projectId,
      ]),
    ).toBe(1);
    expect(command.output().stderr).toContain(
      "outside every existing Git worktree",
    );
  });

  it("rejects a dirty worktree before submitting", async () => {
    const parent = await temporaryDirectory();
    const destination = join(parent, "product-video");
    const command = harness();
    expect(
      await command.run(["init", destination, "--project", projectId]),
    ).toBe(0);
    await writeFile(join(destination, "uncommitted.txt"), "dirty\n");

    expect(await command.run(["submit", destination])).toBe(1);
    expect(command.output().stderr).toContain("Worktree is not clean");
  });

  it("rejects a non-main branch before submitting", async () => {
    const parent = await temporaryDirectory();
    const destination = join(parent, "product-video");
    const command = harness();
    expect(
      await command.run(["init", destination, "--project", projectId]),
    ).toBe(0);
    await git(destination, ["switch", "-c", "feature"]);

    expect(await command.run(["submit", destination])).toBe(1);
    expect(command.output().stderr).toContain("main branch");
  });

  it("posts a bundle with the exact commit and metadata", async () => {
    const parent = await temporaryDirectory();
    const destination = join(parent, "product-video");
    const server = createServer();
    const request = new Promise<{
      body: Buffer;
      headers: Record<string, string | string[] | undefined>;
      method: string | undefined;
      url: string | undefined;
    }>((resolveRequest) => {
      server.once("request", async (incoming, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        resolveRequest({
          body: Buffer.concat(chunks),
          headers: incoming.headers,
          method: incoming.method,
          url: incoming.url,
        });
        response.writeHead(201).end();
      });
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen),
    );

    try {
      const address = z.object({ port: z.number() }).parse(server.address());
      const command = harness();
      expect(
        await command.run([
          "init",
          destination,
          "--project",
          projectId,
          "--studio-origin",
          `http://127.0.0.1:${address.port}`,
        ]),
      ).toBe(0);
      const commitSha = await git(destination, ["rev-parse", "HEAD"]);

      expect(await command.run(["submit", destination])).toBe(0);
      const received = await request;
      expect(received.method).toBe("POST");
      expect(received.url).toBe(`/api/projects/${projectId}/revisions`);
      expect(received.headers["content-type"]).toBe("application/x-git-bundle");
      expect(received.headers["content-length"]).toBe(
        String(received.body.byteLength),
      );
      expect(received.headers["x-video-commit-sha"]).toBe(commitSha);
      expect(received.headers["x-video-ref"]).toBe("refs/heads/main");
      expect(received.headers["x-video-bundle-sha256"]).toBe(
        createHash("sha256").update(received.body).digest("hex"),
      );

      const bundlePath = join(parent, "received.bundle");
      await writeFile(bundlePath, received.body);
      const heads = await git(destination, [
        "bundle",
        "list-heads",
        bundlePath,
      ]);
      expect(heads).toContain(`${commitSha} HEAD`);
      expect(heads).toContain(`${commitSha} refs/heads/main`);
    } finally {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    }
  });
});

function harness() {
  let stdout = "";
  let stderr = "";
  return {
    run: (args: string[]) =>
      runProjectCommand(args, {
        stdout: (value) => {
          stdout += value;
        },
        stderr: (value) => {
          stderr += value;
        },
      }),
    output: () => ({ stdout, stderr }),
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "project-cli-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(
  directory: string,
  args: readonly string[],
): Promise<string> {
  const result = await execFileAsync("git", ["-C", directory, ...args], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}
