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
          <span className="brand-mark" aria-hidden="true">
            PV
          </span>
          <span className="brand-wordmark">
            <span className="brand-name">Programmable Video</span>
            <span className="brand-edition">Studio</span>
          </span>
        </div>
        <div className="header-meta">
          <span>Creator workspace</span>
          <div className="header-status">Ready</div>
        </div>
      </header>

      <div className="studio-content">
        <ProjectPanelComponent />
      </div>
    </div>
  );
}
