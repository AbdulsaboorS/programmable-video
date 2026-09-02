import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProductLaunchComposition } from "./ProductLaunchComposition";
import { defaultProductLaunchProps } from "./manifest";

describe("product launch composition", () => {
  it("holds a complete call to action on the final frame", () => {
    const markup = renderToStaticMarkup(
      <ProductLaunchComposition
        frame={359}
        props={defaultProductLaunchProps}
      />,
    );

    expect(markup).toContain("pl-cta-layer");
    expect(markup).toContain(defaultProductLaunchProps.productName);
    expect(markup).toContain(defaultProductLaunchProps.callToAction);
    expect(markup).toContain("opacity:1;visibility:visible");
  });

  it("clamps an out-of-range frame to the opening", () => {
    const markup = renderToStaticMarkup(
      <ProductLaunchComposition
        frame={-20}
        props={defaultProductLaunchProps}
      />,
    );

    expect(markup).toContain("LAUNCH SIGNAL / 001");
    expect(markup).toContain("<span>000</span>");
  });
});
