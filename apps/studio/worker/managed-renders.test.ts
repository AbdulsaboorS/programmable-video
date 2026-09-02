import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import { createManagedRender } from "./managed-renders";

describe("managed renders", () => {
  it("does not create a render for a revision owned by another user", async () => {
    const create = vi.fn();
    const database = fromPartial<D1Database>({
      prepare: () => ({
        bind: () => ({ first: async () => null }),
      }),
    });

    const response = await createManagedRender(
      "project-1",
      "revision-1",
      "other@example.com",
      fromPartial<Env>({
        PROJECTS_DB: database,
        MANAGED_RENDER_WORKFLOW: { create },
      }),
    );

    expect(response.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });
});
