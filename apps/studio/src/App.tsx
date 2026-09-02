import { Badge, CloudflareLogo } from "@cloudflare/kumo";
import type { ComponentType } from "react";

import { ProjectPanel } from "./ProjectPanel";

export function App({
  ProjectPanelComponent = ProjectPanel,
}: {
  ProjectPanelComponent?: ComponentType;
}) {
  return (
    <div className="studio-shell">
      <header className="studio-header">
        <div className="brand-lockup">
          <CloudflareLogo variant="glyph" className="brand-mark" />
          <span className="brand-name">Programmable Video</span>
          <Badge variant="beta">Prototype</Badge>
        </div>
        <div className="header-meta">
          <span>Creator workspace</span>
          <Badge appearance="dot" variant="success">
            Live
          </Badge>
        </div>
      </header>

      <div className="studio-content">
        <ProjectPanelComponent />
      </div>
    </div>
  );
}
