import type { CSSProperties } from "react";

import { productStorySchema, type ProductStory } from "./story";
import { productFrame } from "./timeline";

export interface ProductCompositionProps {
  frame: number;
  story: ProductStory;
}

interface ProductCompositionStyle extends CSSProperties {
  "--pv-establish": number;
  "--pv-demonstrate": number;
  "--pv-outcome": number;
}

export function ProductComposition({ frame, story }: ProductCompositionProps) {
  const props = productStorySchema.parse(story);
  const timing = productFrame(frame);
  const style: ProductCompositionStyle = {
    "--pv-establish": timing.establish,
    "--pv-demonstrate": timing.demonstrate,
    "--pv-outcome": timing.outcome,
  };

  return (
    <main className="pv-composition" style={style}>
      <header className="pv-topbar">
        <div className="pv-brand-mark">P</div>
        <strong>{props.productName}</strong>
        <span className="pv-status">Live product context</span>
      </header>

      <section className="pv-workspace">
        <aside className="pv-navigation" aria-label="Product navigation">
          <span className="pv-nav-active">Overview</span>
          <span>Activity</span>
          <span>Settings</span>
        </aside>
        <div className="pv-content">
          <p className="pv-eyebrow">Product outcome</p>
          <h1>{props.headline}</h1>
          <p className="pv-detail">{props.detail}</p>

          <div className="pv-metrics">
            <article>
              <span>Ready</span>
              <strong>{Math.round(84 + timing.demonstrate * 15)}%</strong>
            </article>
            <article>
              <span>Time saved</span>
              <strong>{Math.round(timing.demonstrate * 12)}h</strong>
            </article>
            <article>
              <span>Checks</span>
              <strong>{Math.round(timing.demonstrate * 24)}/24</strong>
            </article>
          </div>

          <div className="pv-result">
            <div>
              <span className="pv-result-dot" />
              <div>
                <strong>Workflow complete</strong>
                <p>The final state holds through frame 359.</p>
              </div>
            </div>
            <button type="button">{props.callToAction}</button>
          </div>
        </div>
      </section>
    </main>
  );
}
