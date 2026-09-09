// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App";

afterEach(cleanup);

describe("Studio shell", () => {
  it("presents the managed agent workflow without the legacy workstation", () => {
    render(
      <App
        ProjectPanelComponent={() => <main aria-label="Product projects" />}
      />,
    );

    expect(screen.getByText("Programmable Video")).toBeDefined();
    expect(screen.getByText("Studio")).toBeDefined();
    expect(screen.getByText("Creator workspace")).toBeDefined();
    expect(screen.queryByText("Ready")).toBeNull();
    expect(screen.queryByText("Prototype")).toBeNull();
    expect(screen.getByLabelText("Product projects")).toBeDefined();
    expect(screen.queryByText("Story inspector")).toBeNull();
    expect(screen.queryByRole("button", { name: "Render video" })).toBeNull();
  });
});
