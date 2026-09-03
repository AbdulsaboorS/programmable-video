// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRevision } from "@programmable-video/contracts";
import { z } from "zod";

import { ProjectPanel as StudioProjectPanel } from "./ProjectPanel";
import type { RevisionReviewCanvasProps } from "./RevisionReviewCanvas";
import type { JsonValue } from "./types";

const jsonValueSchema = z.json();
const briefRequestSchema = z.object({ text: z.string() }).passthrough();
const feedbackRequestSchema = z
  .object({
    id: z.string(),
    revisionId: z.string(),
    frame: z.number(),
    fps: z.number(),
    durationInFrames: z.number(),
    text: z.string(),
  })
  .passthrough();

interface CapturedRequest {
  url: string;
  body?: FormData | JsonValue;
}

function TestReviewCanvas({
  revisionId,
  onPositionChange,
}: RevisionReviewCanvasProps) {
  return (
    <div>
      <span>Exact-build review canvas</span>
      <button
        type="button"
        onClick={() =>
          onPositionChange({
            durationInFrames: 360,
            frame: 123,
            fps: 30,
            revisionId,
          })
        }
      >
        Select frame 123
      </button>
    </div>
  );
}

function ProjectPanel() {
  return <StudioProjectPanel ReviewCanvasComponent={TestReviewCanvas} />;
}

const projectId = "0198c7d4-a5e6-7000-8000-000000000000";
const project = {
  id: projectId,
  name: "Acme Dashboard",
  status: "ready",
  source: {
    provider: "github",
    host: "github.com",
    projectPath: "team/product-demo",
    webUrl: "https://github.com/team/product-demo",
    defaultBranch: "main",
    selectedRef: "main",
  },
  repository: {
    kind: "artifacts",
    name: `video-${projectId}`,
    remoteUrl: `https://artifacts.example/video-${projectId}.git`,
    defaultBranch: "main",
    state: "seeded",
  },
  references: [],
  brief: null,
  feedback: [],
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
};

const manifestDigest = "a".repeat(64);
const inputDigest = "b".repeat(64);

function revision(
  id: string,
  commitSha: string,
  overrides: Partial<ProjectRevision> = {},
): ProjectRevision {
  return {
    id,
    projectId,
    commitSha,
    ref: "refs/heads/main",
    isDefaultBranch: true,
    inspectionVersion: 1,
    status: "valid",
    findings: [],
    build: {
      status: "ready",
      attempt: 1,
      checks: [],
      manifestDigest,
      inputDigest,
      startedAt: "2026-08-20T10:01:00.000Z",
      completedAt: "2026-08-20T10:02:00.000Z",
    },
    approval: null,
    latestRender: null,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:02:00.000Z",
    ...overrides,
  };
}

function jsonResponse<ResponseBody>(value: ResponseBody, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseJsonBody(body: BodyInit | null | undefined): JsonValue {
  return jsonValueSchema.parse(JSON.parse(String(body)));
}

function textarea(label: string): HTMLTextAreaElement {
  const element = screen.getByLabelText(label);
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error(`Expected textarea for ${label}`);
  }
  return element;
}

function checkbox(): HTMLInputElement {
  const element = screen.getByRole("checkbox");
  if (!(element instanceof HTMLInputElement)) {
    throw new Error("Expected checkbox input");
  }
  return element;
}

async function openListedProject(
  name = project.name,
  stage?: "Draft" | "Review" | "Finish" | "Published",
) {
  expect(
    await screen.findByRole("heading", { name: "Projects" }),
  ).toBeDefined();
  expect(screen.getByRole("button", { name: "New video" })).toBeDefined();
  const projectFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      /^\/api\/projects\/[^/]+\/publications$/.test(String(input)) &&
      init?.method !== "POST"
        ? Promise.resolve(jsonResponse({ publications: [] }))
        : projectFetch(input, init),
    ),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: (accessibleName) => accessibleName.startsWith(name),
    }),
  );

  await screen.findByRole("button", { name: "All projects" });
  const stageNavigation = screen.getByRole("list", { name: "Video stages" });
  const stageButtons = within(stageNavigation).getAllByRole("button");
  expect(stageButtons.map((button) => button.textContent)).toEqual([
    "1Draft",
    "2Review",
    "3Finish",
    "4Published",
  ]);
  expect(
    stageButtons.filter(
      (button) => button.getAttribute("aria-current") === "step",
    ),
  ).toHaveLength(1);

  if (stage) {
    const stageButton = within(stageNavigation).getByRole("button", {
      name: stage,
    });
    await waitFor(() =>
      expect(stageButton.hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(stageButton);
    expect(stageButton.getAttribute("aria-current")).toBe("step");
  }
}

function provenanceResponse(
  revision: ProjectRevision,
  component = "src/Dashboard.tsx: Dashboard",
) {
  return jsonResponse({
    revisionId: revision.id,
    commitSha: revision.commitSha,
    markdown: `# Source Provenance

## Product Source

- Repository: https://gitlab.example.com/product
- Commit: ${"b".repeat(40)}

## Reused Source

- Components: ${component}
- Styles and fonts: src/dashboard.css
- Icons and assets: src/icons/check.svg

## Adaptations

- Fixed demo data replaces API calls.

## Remaining Visual Differences

- None`,
  });
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("product projects", () => {
  it("loads a project, uploads a reference, and creates a temporary handoff", async () => {
    const requests: CapturedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const request: CapturedRequest = { url };
        if (init?.body) {
          request.body =
            init.body instanceof FormData
              ? init.body
              : parseJsonBody(init.body);
        }
        requests.push(request);
        if (url.endsWith("/references")) {
          return jsonResponse(
            {
              id: "0198c7d4-a5e6-7000-8000-000000000010",
              fileName: "dashboard.png",
              mediaType: "image/png",
              byteSize: 2048,
              note: "Authenticated dashboard",
              storageState: "uploaded",
              width: 1280,
              height: 720,
              createdAt: "2026-08-20T10:05:00.000Z",
            },
            201,
          );
        }
        if (url.endsWith("/handoffs")) {
          return jsonResponse(
            {
              kind: "artifacts",
              remoteUrl: project.repository.remoteUrl,
              token: "temporary-'token",
              tokenExpiresAt: "2026-08-20T11:00:00.000Z",
              defaultBranch: "main",
              references: [
                {
                  id: "0198c7d4-a5e6-7000-8000-000000000010",
                  fileName: "dashboard.png",
                  downloadUrl:
                    "https://studio.example/api/internal/project-references/0198c7d4-a5e6-7000-8000-000000000010",
                  token: "reference-token",
                  sha256: "a".repeat(64),
                },
              ],
            },
            201,
          );
        }
        if (url.endsWith("/brief")) {
          const text = briefRequestSchema.parse(parseJsonBody(init?.body)).text;
          return jsonResponse({
            text,
            updatedAt: "2026-08-20T10:06:00.000Z",
          });
        }
        if (url.endsWith("/revisions")) {
          return jsonResponse({ revisions: [] });
        }
        return jsonResponse({
          projects: [
            {
              ...project,
              references: [
                {
                  id: "0198c7d4-a5e6-7000-8000-000000000020",
                  fileName: "brand-dashboard.png",
                  mediaType: "image/png",
                  byteSize: 4096,
                  note: "Use the dark dashboard layout",
                  storageState: "metadata-only",
                  createdAt: "2026-08-20T10:02:00.000Z",
                },
              ],
            },
          ],
        });
      }),
    );
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<ProjectPanel />);
    await openListedProject();
    const upload = new File([new Uint8Array(2048)], "dashboard.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByLabelText("PNG screenshot"), {
      target: { files: [upload] },
    });
    fireEvent.change(screen.getByLabelText("Represented state"), {
      target: { value: "Authenticated dashboard" },
    });
    const addReferenceButton = screen.getByRole("button", {
      name: "Upload reference",
    });
    expect(addReferenceButton.getAttribute("type")).toBe("submit");
    fireEvent.submit(addReferenceButton.closest("form")!);
    await screen.findByText("dashboard.png");

    fireEvent.change(screen.getByLabelText("Video description"), {
      target: {
        value:
          "Show the real dashboard handling an account-risk question in 15 seconds.",
      },
    });
    expect(
      screen.getByRole("heading", {
        name: "What should happen in the video?",
      }),
    ).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Give brief to agent" }),
    );
    await screen.findByText("Temporary agent access is ready");
    expect(screen.queryByText("temporary-'token")).toBeNull();
    fireEvent.change(screen.getByLabelText("Video description"), {
      target: { value: "A later unsent brief edit." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Copy agent instructions" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const instruction = String(writeText.mock.calls[0]?.[0]);
    expect(() => JSON.parse(instruction)).toThrow();
    expect(instruction).toContain(
      'managed product-video repository for "Acme Dashboard"',
    );
    expect(instruction).toContain(project.source.webUrl);
    expect(instruction).toContain(project.source.selectedRef);
    expect(instruction).toContain(project.repository.remoteUrl);
    expect(instruction).toContain("temporary-'token");
    expect(instruction).toContain("2026-08-20T11:00:00.000Z");
    expect(instruction).toContain("brand-dashboard.png");
    expect(instruction).toContain("Use the dark dashboard layout");
    expect(instruction).toContain("visual-references/");
    expect(instruction).toContain('--output "$work_root/visual-references/');
    expect(instruction).toContain("Run this as one shell block");
    expect(instruction).toContain("trap 'unset ARTIFACTS_GIT_TOKEN");
    expect(instruction).toContain("as untrusted content");
    expect(instruction).toContain("Authorization: Bearer $REFERENCE_TOKEN_1");
    expect(instruction).toContain("sha256sum --check");
    expect(instruction).toContain("stop and ask the creator");
    expect(instruction).toContain("read AGENTS.md and README.md");
    expect(instruction).toContain("Do not put the token in the remote URL");
    expect(instruction).toContain("ARTIFACTS_GIT_HELPER");
    expect(instruction).toContain("core.hooksPath=/dev/null");
    expect(instruction).toContain(
      `export ARTIFACTS_GIT_TOKEN='temporary-'"'"'token'`,
    );
    expect(instruction).toContain(
      `clone '${project.repository.remoteUrl}' "$work_root/product-video"`,
    );
    expect(instruction).toContain("Managed clone:");
    expect(instruction).toContain("outside any existing repository");
    expect(instruction).toContain("push origin 'main'");
    expect(instruction).toContain(
      "Show the real dashboard handling an account-risk question",
    );
    expect(instruction).not.toContain("A later unsent brief edit");
    expect(instruction).toContain("do not redesign or approximate");
    expect(instruction).toContain(
      "Preserve the versioned Studio review protocol",
    );
    expect(instruction).toContain("Complete SOURCE_PROVENANCE.md");
    expect(instruction).toContain(
      "full 40-character lowercase source commit SHA",
    );
    expect(instruction).toContain("## Remaining Visual Differences");
    expect(instruction).toContain("pnpm install --frozen-lockfile");
    expect(instruction).toContain("pnpm verify");
    expect(instruction.indexOf("unset ARTIFACTS_GIT_TOKEN")).toBeLessThan(
      instruction.indexOf("pnpm install --frozen-lockfile"),
    );
    expect(instruction).toContain(
      "The Git token must remain unset while project-controlled commands run",
    );
    expect(instruction).toContain("do not ask the creator to run Git commands");
    expect(instruction).toContain("Report the pushed commit SHA");
    expect(instruction).toContain("resolved source commit");
    expect(
      requests.findIndex(({ url }) => url.endsWith("/brief")),
    ).toBeLessThan(requests.findIndex(({ url }) => url.endsWith("/handoffs")));
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: `/api/projects/${projectId}/references`,
          body: expect.any(FormData),
        }),
        expect.objectContaining({ url: `/api/projects/${projectId}/handoffs` }),
        expect.objectContaining({
          url: `/api/projects/${projectId}/revisions`,
        }),
      ]),
    );
    const referenceRequest = requests.find(({ url }) =>
      url.endsWith("/references"),
    );
    const referenceForm = referenceRequest?.body;
    if (!(referenceForm instanceof FormData)) {
      throw new Error("Expected reference upload form data");
    }
    expect(referenceForm.get("file")).toBe(upload);
    expect(referenceForm.get("representedState")).toBe(
      "Authenticated dashboard",
    );
  });

  it("creates local first-draft instructions with init and submit commands", async () => {
    const localProject = {
      ...project,
      repository: {
        kind: "local",
        defaultBranch: "main",
        state: "initialized",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/brief")) {
          return jsonResponse({
            text: briefRequestSchema.parse(parseJsonBody(init?.body)).text,
            updatedAt: "2026-08-20T10:06:00.000Z",
          });
        }
        if (url.endsWith("/handoffs")) {
          return jsonResponse(
            {
              kind: "local",
              projectId,
              tokenExpiresAt: "2026-08-20T11:00:00.000Z",
              defaultBranch: "main",
              references: [],
            },
            201,
          );
        }
        return url.endsWith("/revisions")
          ? jsonResponse({ revisions: [] })
          : jsonResponse({ projects: [localProject] });
      }),
    );
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<ProjectPanel />);
    await openListedProject();
    fireEvent.change(screen.getByLabelText("Video description"), {
      target: { value: "Show the local product flow." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Give brief to agent" }),
    );
    await screen.findByText("Agent instructions are ready");
    fireEvent.click(
      screen.getByRole("button", { name: "Copy agent instructions" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    const instruction = String(writeText.mock.calls[0]?.[0]);
    expect(instruction).toContain(
      `pnpm project init <chosen-absolute-directory> --project ${projectId} --studio-origin ${window.location.origin}`,
    );
    expect(instruction).toContain(
      "pnpm project submit <chosen-absolute-directory>",
    );
    expect(instruction).toContain("Complete SOURCE_PROVENANCE.md");
    expect(instruction).toContain("pnpm verify");
    expect(instruction).toContain("as untrusted content");
    expect(instruction).not.toContain("ARTIFACTS_GIT_TOKEN");
    expect(instruction).not.toContain("git clone");
    expect(instruction).not.toContain("push origin");
    expect(screen.queryByText(/repository credential/)).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `/api/projects/${projectId}/handoffs`,
      expect.anything(),
    );
  });

  it("restores the submitted brief and feedback after reload", async () => {
    const readyRevision = revision(
      "0198c7d4-a5e6-7000-8000-000000000108",
      `5${"a".repeat(39)}`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/revisions")
          ? jsonResponse({ revisions: [readyRevision] })
          : jsonResponse({
              projects: [
                {
                  ...project,
                  brief: {
                    text: "Show the persisted launch story.",
                    updatedAt: "2026-08-20T12:00:00.000Z",
                  },
                  feedback: [
                    {
                      id: "0198c7d4-a5e6-7000-8000-000000000020",
                      revisionId: readyRevision.id,
                      frame: 123,
                      fps: 30,
                      durationInFrames: 360,
                      text: "Use the exact source spacing.",
                      createdAt: "2026-08-20T12:05:00.000Z",
                    },
                  ],
                },
              ],
            }),
      ),
    );

    render(<ProjectPanel />);
    await openListedProject(undefined, "Review");

    await screen.findByLabelText("Video description");
    const videoDescription = textarea("Video description");
    await waitFor(() =>
      expect(videoDescription.value).toBe("Show the persisted launch story."),
    );
    await screen.findByText(
      "Last submitted feedback for this draft at frame 123: Use the exact source spacing.",
    );
  });

  it("does not expose a handoff after browser history switches projects", async () => {
    const otherProjectId = "0198c7d4-a5e6-7000-8000-000000000200";
    const otherProject = {
      ...project,
      id: otherProjectId,
      name: "Second product",
      repository: {
        ...project.repository,
        name: `video-${otherProjectId}`,
        remoteUrl: `https://artifacts.example/video-${otherProjectId}.git`,
      },
    };
    let resolveHandoff: (response: Response) => void = () => undefined;
    const handoffResponse = new Promise<Response>((resolve) => {
      resolveHandoff = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `/api/projects/${projectId}/handoffs`) {
          return handoffResponse;
        }
        if (url === `/api/projects/${projectId}/brief`) {
          return jsonResponse({
            text: briefRequestSchema.parse(parseJsonBody(init?.body)).text,
            updatedAt: "2026-08-20T10:06:00.000Z",
          });
        }
        if (url.endsWith("/revisions")) {
          return jsonResponse({ revisions: [] });
        }
        return jsonResponse({ projects: [project, otherProject] });
      }),
    );

    render(<ProjectPanel />);
    await openListedProject();
    fireEvent.change(screen.getByLabelText("Video description"), {
      target: { value: "Show the first product." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Give brief to agent" }),
    );
    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `/api/projects/${projectId}/handoffs`,
        expect.anything(),
      ),
    );

    window.history.pushState({}, "", `/?project=${otherProjectId}&stage=draft`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await screen.findByRole("heading", {
      name: "What should happen in the video?",
    });
    await waitFor(() => expect(textarea("Video description").value).toBe(""));

    resolveHandoff(
      jsonResponse(
        {
          kind: "artifacts",
          remoteUrl: project.repository.remoteUrl,
          token: "first-project-temporary-token",
          tokenExpiresAt: "2026-08-20T11:00:00.000Z",
          defaultBranch: "main",
          references: [],
        },
        201,
      ),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "All projects" }),
      ).toBeDefined(),
    );
    expect(screen.queryByText("first-project-temporary-token")).toBeNull();
    expect(
      screen.queryByText("Agent instructions are ready for one hour"),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("creates the first product project from strict source details", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/revisions")) {
          return jsonResponse({ revisions: [] });
        }
        if (url.endsWith("/publications")) {
          return jsonResponse({ publications: [] });
        }
        return init?.method === "POST"
          ? jsonResponse(project, 201)
          : jsonResponse({ projects: [] });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPanel />);
    await screen.findByRole("heading", { name: "Projects" });
    await screen.findByRole("heading", { name: "No projects yet" });
    fireEvent.click(screen.getByRole("button", { name: "New video" }));
    await screen.findByLabelText("Project name");
    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "Acme Dashboard" },
    });
    fireEvent.change(screen.getByLabelText("GitHub repository URL"), {
      target: { value: "https://github.com/team/product-demo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect product" }));

    await screen.findByRole("heading", {
      name: "What should happen in the video?",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      requestId: expect.any(String),
      name: "Acme Dashboard",
      githubUrl: "https://github.com/team/product-demo",
      defaultBranch: "main",
    });
  });

  it("surfaces a safe load failure and keeps project creation available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "Authentication required" }, 401),
      ),
    );
    render(<ProjectPanel />);

    await screen.findByText(/Authentication required/);
    fireEvent.click(screen.getByRole("button", { name: "New video" }));
    expect(screen.getByLabelText("Project name")).toBeDefined();
  });

  it("shows bounded newest-first revision statuses and findings", async () => {
    const statuses = ["pending", "valid", "invalid", "error"] as const;
    const revisions = Array.from({ length: 12 }, (_, index) => ({
      id: `0198c7d4-a5e6-7000-8000-${String(index).padStart(12, "0")}`,
      projectId,
      commitSha: `${String(index).padStart(2, "0")}${"a".repeat(38)}`,
      ref: "refs/heads/main",
      isDefaultBranch: true,
      inspectionVersion: 1,
      status: statuses[index % statuses.length],
      findings:
        index === 11
          ? [
              {
                severity: "error",
                code: "manifest.missing",
                message: "Composition manifest is missing",
                path: "src/manifest.ts",
                line: 12,
              },
            ]
          : [],
      build: null,
      approval: null,
      latestRender: null,
      createdAt: `2026-08-20T${String(index).padStart(2, "0")}:00:00.000Z`,
      updatedAt: `2026-08-20T${String(index).padStart(2, "0")}:01:00.000Z`,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/revisions")
          ? jsonResponse({ revisions })
          : jsonResponse({ projects: [project] }),
      ),
    );

    render(<ProjectPanel />);
    await openListedProject();

    fireEvent.click(screen.getByRole("button", { name: "Technical details" }));
    await screen.findByText(/Composition manifest is missing/);
    expect(screen.getByTitle(revisions[11]!.commitSha)).toBeDefined();
    expect(screen.queryByTitle(revisions[1]!.commitSha)).toBeNull();
    const revisionSection = screen
      .getByRole("heading", { name: "Revision and build status" })
      .closest("section");
    if (!(revisionSection instanceof HTMLElement)) {
      throw new Error("Expected revision status section");
    }
    const revisionList = within(revisionSection).getAllByRole("list")[0];
    if (!(revisionList instanceof HTMLOListElement)) {
      throw new Error("Expected ordered revision list");
    }
    expect(revisionList.children).toHaveLength(10);
    for (const status of statuses) {
      expect(screen.getAllByText(status).length).toBeGreaterThan(0);
    }
  });

  it("shows empty revision history independently from project actions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/revisions")
          ? jsonResponse({ revisions: [] })
          : jsonResponse({ projects: [project] }),
      ),
    );

    render(<ProjectPanel />);
    await openListedProject();

    fireEvent.click(screen.getByRole("button", { name: "Technical details" }));
    await screen.findByText("No revisions yet.");
    expect(screen.getByLabelText("Video description")).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: "Give brief to agent" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps the last successful draft available when newer changes fail", async () => {
    const readyRevision = revision(
      "0198c7d4-a5e6-7000-8000-000000000101",
      `1${"a".repeat(39)}`,
      {
        approval: {
          approvedAt: "2026-08-20T10:03:00.000Z",
          manifestDigest,
          inputDigest,
          attempt: 1,
        },
      },
    );
    const failedRevision = revision(
      "0198c7d4-a5e6-7000-8000-000000000102",
      `2${"a".repeat(39)}`,
      {
        status: "invalid",
        build: {
          status: "invalid",
          attempt: 1,
          checks: [],
          manifestDigest: null,
          inputDigest: null,
          startedAt: "2026-08-20T11:01:00.000Z",
          completedAt: "2026-08-20T11:02:00.000Z",
        },
        createdAt: "2026-08-20T11:00:00.000Z",
        updatedAt: "2026-08-20T11:02:00.000Z",
      },
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/preview-session")) {
        return jsonResponse({
          url: "https://preview.example/session",
          expiresAt: "2026-08-20T11:10:00.000Z",
        });
      }
      return url.endsWith("/revisions")
        ? jsonResponse({ revisions: [failedRevision, readyRevision] })
        : jsonResponse({ projects: [project] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    render(<ProjectPanel />);
    await openListedProject(undefined, "Review");

    await screen.findByText("Newer changes are not ready.");
    expect(
      screen.getByText(
        "The last successful draft remains available for review.",
      ),
    ).toBeDefined();
    expect(screen.getByText(/Draft 1aaaaaaa/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Finish" })).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Open interactive preview" }),
    );

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`${readyRevision.id}/preview-session`),
      expect.anything(),
    );
  });

  it("keeps preview recovery available after a request failure", async () => {
    const readyRevision = revision(
      "0198c7d4-a5e6-7000-8000-000000000108",
      `5${"a".repeat(39)}`,
    );
    let previewAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/preview-session")) {
        previewAttempts += 1;
        return previewAttempts === 1
          ? jsonResponse({ error: "Preview service unavailable" }, 503)
          : jsonResponse({
              url: "https://preview.example/recovered",
              expiresAt: "2026-08-20T14:10:00.000Z",
            });
      }
      return url.endsWith("/revisions")
        ? jsonResponse({ revisions: [readyRevision] })
        : jsonResponse({ projects: [project] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    render(<ProjectPanel />);
    await openListedProject(undefined, "Review");

    const previewButton = await screen.findByRole("button", {
      name: "Open interactive preview",
    });
    fireEvent.click(previewButton);
    await screen.findByText("Preview service unavailable");
    expect(
      screen.getByRole("button", { name: "Open interactive preview" }),
    ).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Open interactive preview" }),
    );
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Preview service unavailable")).toBeNull();
  });

  it("shows and switches uploaded references beside the exact build", async () => {
    const readyRevision = revision(
      "0198c7d4-a5e6-7000-8000-000000000118",
      `8${"a".repeat(39)}`,
    );
    const references = [
      {
        id: "0198c7d4-a5e6-7000-8000-000000000210",
        fileName: "dashboard.png",
        mediaType: "image/png",
        byteSize: 2048,
        note: "Dashboard after login",
        storageState: "uploaded",
        width: 1280,
        height: 720,
        createdAt: "2026-08-24T10:00:00.000Z",
      },
      {
        id: "0198c7d4-a5e6-7000-8000-000000000211",
        fileName: "settings.png",
        mediaType: "image/png",
        byteSize: 4096,
        note: "Settings panel open",
        storageState: "uploaded",
        width: 1280,
        height: 720,
        createdAt: "2026-08-24T10:01:00.000Z",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/provenance")) {
          return provenanceResponse(readyRevision);
        }
        return url.endsWith("/revisions")
          ? jsonResponse({ revisions: [readyRevision] })
          : jsonResponse({ projects: [{ ...project, references }] });
      }),
    );

    render(<ProjectPanel />);
    await openListedProject(undefined, "Review");

    const first = await screen.findByAltText("Dashboard after login");
    expect(first.getAttribute("src")).toBe(
      `/api/projects/${projectId}/references/${references[0]!.id}/content`,
    );
    fireEvent.error(first);
    expect(
      await screen.findByText("Product reference could not be loaded"),
    ).toBeDefined();
    expect(screen.getByRole("checkbox").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry image" }));
    expect(screen.getByText("Loading product reference")).toBeDefined();
    fireEvent.load(first);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(checkbox().checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Compare another state"), {
      target: { value: references[1]!.id },
    });
    const second = await screen.findByAltText("Settings panel open");
    expect(second.getAttribute("src")).toBe(
      `/api/projects/${projectId}/references/${references[1]!.id}/content`,
    );
    expect(checkbox().checked).toBe(false);
    fireEvent.load(second);
    expect(screen.getByRole("checkbox").hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Exact-build review canvas")).toBeDefined();
  });

  it("uses the full review canvas when no product reference was uploaded", async () => {
    const readyRevision = revision(
      "0198c7d4-a5e6-7000-8000-000000000218",
      `d${"a".repeat(39)}`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/provenance")) {
          return provenanceResponse(readyRevision);
        }
        return url.endsWith("/revisions")
          ? jsonResponse({ revisions: [readyRevision] })
          : jsonResponse({ projects: [project] });
      }),
    );

    render(<ProjectPanel />);
    await openListedProject(undefined, "Review");

    await screen.findByText("Exact-build review canvas");
    expect(screen.queryByText("Product reference")).toBeNull();
    const comparison = screen.getByText("Exact-build review canvas")
      .parentElement?.parentElement;
    if (!(comparison instanceof HTMLElement)) {
      throw new Error("Expected draft review comparison");
    }
    expect(comparison.classList).toContain("single");
  });

  it("blocks approval until exact-revision provenance loads and supports retry", async () => {
    const readyRevision = revision(
      "0198c7d4-a5e6-7000-8000-000000000119",
      `9${"a".repeat(39)}`,
    );
    let provenanceAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/provenance")) {
        provenanceAttempts += 1;
        return provenanceAttempts === 1
          ? jsonResponse({ error: "Source provenance is unavailable" }, 502)
          : provenanceResponse(readyRevision);
      }
      return url.endsWith("/revisions")
        ? jsonResponse({ revisions: [readyRevision] })
        : jsonResponse({ projects: [project] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPanel />);
    await openListedProject(undefined, "Review");

    const blockedCheckbox = await screen.findByLabelText(
      "Load the exact draft's source evidence before confirming",
    );
    expect(blockedCheckbox.hasAttribute("disabled")).toBe(true);
    expect(
      await screen.findAllByText("Source provenance is unavailable"),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Retry provenance" }));

    await screen.findByText("## Product Source", { exact: false });
    expect(screen.getByText(readyRevision.commitSha)).toBeDefined();
    expect(
      screen
        .getByLabelText(
          "I checked the product UI and found no unintended changes",
        )
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith(`/${readyRevision.id}/provenance`),
      ),
    ).toHaveLength(2);
  });

  it("ignores provenance that resolves after its project request is aborted", async () => {
    const otherProjectId = "0198c7d4-a5e6-7000-8000-000000000200";
    const firstRevision = revision(
      "0198c7d4-a5e6-7000-8000-000000000120",
      `a${"1".repeat(39)}`,
    );
    const secondRevision = revision(
      "0198c7d4-a5e6-7000-8000-000000000121",
      `b${"2".repeat(39)}`,
      { projectId: otherProjectId },
    );
    const otherProject = {
      ...project,
      id: otherProjectId,
      name: "Second product",
      repository: {
        ...project.repository,
        name: `video-${otherProjectId}`,
      },
    };
    let firstSignal: AbortSignal | undefined;
    let resolveFirst: (response: Response) => void = () => undefined;
    const firstProvenance = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/${firstRevision.id}/provenance`)) {
          firstSignal = init?.signal ?? undefined;
          return firstProvenance;
        }
        if (url.endsWith(`/${secondRevision.id}/provenance`)) {
          return provenanceResponse(
            secondRevision,
            "src/SecondProduct.tsx: SecondProduct",
          );
        }
        if (url === `/api/projects/${projectId}/revisions`) {
          return jsonResponse({ revisions: [firstRevision] });
        }
        if (url === `/api/projects/${otherProjectId}/revisions`) {
          return jsonResponse({ revisions: [secondRevision] });
        }
        return jsonResponse({ projects: [project, otherProject] });
      }),
    );

    render(<ProjectPanel />);
    await openListedProject(undefined, "Review");

    await screen.findByText(`Draft ${firstRevision.commitSha.slice(0, 8)}`);
    fireEvent.click(screen.getByRole("button", { name: "All projects" }));
    await openListedProject(otherProject.name, "Review");
    await screen.findByText(secondRevision.commitSha);
    await screen.findByText(/src\/SecondProduct\.tsx/);
    expect(firstSignal?.aborted).toBe(true);

    resolveFirst(
      provenanceResponse(firstRevision, "src/FirstProduct.tsx: FirstProduct"),
    );
    await waitFor(() =>
      expect(screen.getByText(/src\/SecondProduct\.tsx/)).toBeDefined(),
    );
    expect(screen.queryByText(/src\/FirstProduct\.tsx/)).toBeNull();
    expect(
      screen
        .getByLabelText(
          "I checked the product UI and found no unintended changes",
        )
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.queryByText(firstRevision.commitSha)).toBeNull();
  });

  it("creates revision-specific change instructions without discarding the preview", async () => {
    const readyRevision = revision(
      "0198c7d4-a5e6-7000-8000-000000000109",
      `6${"a".repeat(39)}`,
    );
    const localProject = {
      ...project,
      repository: {
        kind: "local",
        defaultBranch: "main",
        state: "initialized",
      },
    };
    let resolveHandoff: (response: Response) => void = () => undefined;
    const handoffResponse = new Promise<Response>((resolve) => {
      resolveHandoff = resolve;
    });
    const requestUrls: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requestUrls.push(url);
        if (url.endsWith("/handoffs")) {
          return handoffResponse;
        }
        if (url.endsWith("/feedback")) {
          return jsonResponse(
            {
              ...feedbackRequestSchema.parse(parseJsonBody(init?.body)),
              createdAt: "2026-08-20T14:00:00.000Z",
            },
            201,
          );
        }
        return url.endsWith("/revisions")
          ? jsonResponse({ revisions: [readyRevision] })
          : jsonResponse({ projects: [localProject] });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<ProjectPanel />);
    await openListedProject(undefined, "Review");

    fireEvent.change(await screen.findByLabelText("Video description"), {
      target: { value: "An unsent replacement brief." },
    });
    const feedback = await screen.findByLabelText(
      "What should the agent change?",
    );
    fireEvent.change(feedback, { target: { value: "   " } });
    expect(
      screen
        .getByRole("button", { name: /Request changes/ })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.change(feedback, {
      target: {
        value: "Match the source orb exactly and keep the current timing.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Select frame 123" }));
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));

    expect(
      screen
        .getByRole("button", { name: /Request changes/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: /Request changes/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    resolveHandoff(
      jsonResponse(
        {
          kind: "local",
          projectId,
          tokenExpiresAt: "2026-08-20T15:00:00.000Z",
          defaultBranch: "main",
          references: [],
        },
        201,
      ),
    );

    await screen.findByText("Temporary change instructions are ready");
    expect(
      screen
        .getByRole("button", { name: "Request changes" })
        .hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.change(feedback, {
      target: { value: "A later unsent feedback edit." },
    });
    expect(
      screen.getByRole("button", { name: "Open interactive preview" }),
    ).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Copy change instructions" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const instruction = String(writeText.mock.calls[0]?.[0]);
    expect(instruction).toContain("Change request");
    expect(instruction).toContain(readyRevision.commitSha);
    expect(instruction).toContain("Reviewed frame: 123 at 00:04.100 (30 fps)");
    expect(instruction).toContain("has moved ahead");
    expect(instruction).toContain("Do not reset or rewrite history");
    expect(instruction).toContain(
      "Match the source orb exactly and keep the current timing.",
    );
    expect(instruction).not.toContain("An unsent replacement brief");
    expect(instruction).not.toContain("A later unsent feedback edit");
    expect(instruction).toContain("pnpm verify");
    expect(instruction).toContain(
      `existing initialized workspace tied to project ID ${projectId}`,
    );
    expect(instruction).toContain(
      "pnpm project submit <known-local-project-directory>",
    );
    expect(instruction).not.toContain("pnpm project init");
    expect(instruction).not.toContain("ARTIFACTS_GIT_TOKEN");
    expect(instruction).not.toContain("git clone");
    expect(instruction).not.toContain("push origin");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/projects/${projectId}/handoffs`,
      expect.anything(),
    );
    expect(
      requestUrls.findIndex((url) => url.endsWith("/feedback")),
    ).toBeLessThan(requestUrls.findIndex((url) => url.endsWith("/handoffs")));
  });

  it("preserves change feedback and preview recovery when handoff creation fails", async () => {
    const readyRevision = revision(
      "0198c7d4-a5e6-7000-8000-000000000110",
      `7${"a".repeat(39)}`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/handoffs")) {
          return jsonResponse({ error: "Agent access unavailable" }, 503);
        }
        if (url.endsWith("/feedback")) {
          return jsonResponse(
            {
              ...feedbackRequestSchema.parse(parseJsonBody(init?.body)),
              createdAt: "2026-08-20T14:00:00.000Z",
            },
            201,
          );
        }
        return url.endsWith("/revisions")
          ? jsonResponse({ revisions: [readyRevision] })
          : jsonResponse({ projects: [project] });
      }),
    );

    render(<ProjectPanel />);
    await openListedProject(undefined, "Review");

    const feedback = await screen.findByLabelText(
      "What should the agent change?",
    );
    fireEvent.change(feedback, {
      target: { value: "Correct the product formatting." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Select frame 123" }));
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));

    await screen.findByText("Agent access unavailable");
    expect(textarea("What should the agent change?").value).toBe(
      "Correct the product formatting.",
    );
    expect(
      screen.getByRole("button", { name: "Open interactive preview" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Request changes" }),
    ).toBeDefined();
  });

  it("requires product-match confirmation before approval and opens finishing", async () => {
    let currentRevision = revision(
      "0198c7d4-a5e6-7000-8000-000000000103",
      `3${"a".repeat(39)}`,
    );
    const approval = {
      approvedAt: "2026-08-20T12:03:00.000Z",
      manifestDigest,
      inputDigest,
      attempt: 1,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/provenance")) {
        return provenanceResponse(currentRevision);
      }
      if (url.endsWith("/approval")) {
        currentRevision = { ...currentRevision, approval };
        return jsonResponse(approval);
      }
      if (url.endsWith("/publications"))
        return jsonResponse({ publications: [] });
      if (url.endsWith("/media")) return jsonResponse({ assets: [] });
      return url.endsWith("/revisions")
        ? jsonResponse({ revisions: [currentRevision] })
        : jsonResponse({ projects: [project] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPanel />);
    await openListedProject(undefined, "Review");

    const approveButton = await screen.findByRole("button", {
      name: "Approve draft",
    });
    expect(screen.getByText("New draft ready to review")).toBeDefined();
    expect(approveButton.hasAttribute("disabled")).toBe(true);
    const confirmation = await screen.findByLabelText(
      "I checked the product UI and found no unintended changes",
    );
    fireEvent.click(confirmation);
    expect(approveButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(approveButton);

    fireEvent.click(screen.getByRole("button", { name: "Select frame 123" }));
    const continueButton = await screen.findByRole("button", {
      name: "Continue to Finish",
    });
    const finishButton = screen.getByRole("button", { name: "Finish" });
    await waitFor(() =>
      expect(finishButton.hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(continueButton);
    await screen.findByRole("heading", { name: "Finish video" });
    expect(
      screen.getByRole("heading", { name: "Prepare the approved video" }),
    ).toBeDefined();
    expect(finishButton.getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("Exact-build review canvas")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`${currentRevision.id}/approval`),
      expect.anything(),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining(`${currentRevision.id}/renders`),
      expect.anything(),
    );
  });

  it.each([
    ["attempt", { attempt: 2 }],
    ["digest", { manifestDigest: "c".repeat(64) }],
  ])(
    "treats a stale %s approval as unapproved",
    async (_mismatch, approvalOverride) => {
      const readyRevision = revision(
        "0198c7d4-a5e6-7000-8000-000000000104",
        `4${"b".repeat(39)}`,
        {
          approval: {
            approvedAt: "2026-08-20T12:03:00.000Z",
            manifestDigest,
            inputDigest,
            attempt: 1,
            ...approvalOverride,
          },
        },
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith("/provenance")) {
            return provenanceResponse(readyRevision);
          }
          return url.endsWith("/revisions")
            ? jsonResponse({ revisions: [readyRevision] })
            : jsonResponse({ projects: [project] });
        }),
      );

      render(<ProjectPanel />);
      await openListedProject(undefined, "Review");

      expect(
        await screen.findByLabelText(
          "I checked the product UI and found no unintended changes",
        ),
      ).toBeDefined();
      expect(
        screen.getByRole("button", { name: "Approve draft" }),
      ).toBeDefined();
      expect(
        screen.getByRole("button", { name: "Finish" }).hasAttribute("disabled"),
      ).toBe(true);
      expect(
        screen.queryByText("This draft is approved and ready to finish."),
      ).toBeNull();
    },
  );

  it("keeps the approved source canvas visible for a legacy failed render", async () => {
    const revisionId = "0198c7d4-a5e6-7000-8000-000000000105";
    let currentRevision = revision(revisionId, `4${"a".repeat(39)}`, {
      approval: {
        approvedAt: "2026-08-20T13:03:00.000Z",
        manifestDigest,
        inputDigest,
        attempt: 1,
      },
      latestRender: {
        status: "failed",
        id: "0198c7d4-a5e6-7000-8000-000000000106",
        error: "Chromium closed during frame capture",
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/publications"))
        return jsonResponse({ publications: [] });
      if (url.endsWith("/media")) return jsonResponse({ assets: [] });
      return url.endsWith("/revisions")
        ? jsonResponse({ revisions: [currentRevision] })
        : jsonResponse({ projects: [project] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPanel />);
    await openListedProject(undefined, "Review");

    await screen.findByText("Exact-build review canvas");
    fireEvent.click(screen.getByRole("button", { name: "Select frame 123" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    await screen.findByRole("heading", { name: "Finish video" });
    expect(
      screen.queryByText("Chromium closed during frame capture"),
    ).toBeNull();
  });

  it("retries a preview build after a platform error", async () => {
    const revisionId = "0198c7d4-a5e6-7000-8000-000000000108";
    let currentRevision = revision(revisionId, `5${"a".repeat(39)}`, {
      build: {
        status: "error",
        attempt: 1,
        checks: [],
        manifestDigest: null,
        inputDigest: null,
        startedAt: "2026-08-20T13:01:00.000Z",
        completedAt: "2026-08-20T13:02:00.000Z",
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/build-retry")) {
        currentRevision = {
          ...currentRevision,
          build: {
            ...currentRevision.build!,
            status: "queued",
            attempt: 2,
            startedAt: null,
            completedAt: null,
          },
        };
        return jsonResponse({ status: "queued", attempt: 2 }, 202);
      }
      return url.endsWith("/revisions")
        ? jsonResponse({ revisions: [currentRevision] })
        : jsonResponse({ projects: [project] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPanel />);
    await openListedProject();

    fireEvent.click(screen.getByRole("button", { name: "Technical details" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry preview build" }),
    );

    await screen.findByText(/Build: queued, attempt 2/);
    expect(
      screen.getByRole("button", { name: "Resume preview build" }),
    ).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`${revisionId}/build-retry`),
      expect.anything(),
    );
  });

  it("shows revision loading independently from panel mutations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/revisions")) {
          return new Promise<Response>(() => undefined);
        }
        return jsonResponse({ projects: [project] });
      }),
    );

    render(<ProjectPanel />);
    await openListedProject();

    await screen.findByText("Checking for agent changes.");
    expect(
      screen.getByRole("button", { name: "Upload reference" }),
    ).toBeDefined();
  });

  it.each([
    [
      jsonResponse({ error: "Revision service unavailable" }, 503),
      "Revision service unavailable",
    ],
    [
      jsonResponse({ revisions: [{ status: "valid" }] }),
      "Revision API returned invalid data",
    ],
  ])(
    "surfaces revision load errors without replacing the project",
    async (response, message) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) =>
          String(input).endsWith("/revisions")
            ? response
            : jsonResponse({ projects: [project] }),
        ),
      );

      render(<ProjectPanel />);
      await openListedProject();

      await screen.findByText(message);
      expect(
        screen.getByRole("button", { name: "All projects" }),
      ).toBeDefined();
    },
  );
});
