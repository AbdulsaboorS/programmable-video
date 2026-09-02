import {
  defineCompositionManifest,
  videoSpec,
} from "@programmable-video/contracts";
import { z } from "zod";

export const productLaunchPropsSchema = z
  .object({
    productName: z.string().trim().min(1).max(48),
    headline: z.string().trim().min(1).max(92),
    supportingCopy: z.string().trim().min(1).max(220),
    benefits: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .superRefine((value, context) => {
        const lines = value
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        if (lines.length !== 3) {
          context.addIssue({
            code: "custom",
            message: "Enter exactly three non-empty benefits, one per line",
          });
        }
      }),
    callToAction: z.string().trim().min(1).max(64),
  })
  .strict();

export type ProductLaunchProps = z.infer<typeof productLaunchPropsSchema>;

export const defaultProductLaunchProps = {
  productName: "Vector",
  headline: "Ship the idea while it is still electric.",
  supportingCopy:
    "Vector turns rough launch notes into one clear, review-ready release story.",
  benefits: "Shape the signal\nAlign every team\nLaunch with momentum",
  callToAction: "Start building at vector.example",
} satisfies ProductLaunchProps;

export const productLaunchManifest = defineCompositionManifest({
  id: "product-launch",
  label: "Product launch",
  description: "Announce a product through a kinetic launch signal.",
  spec: videoSpec,
  propsSchema: productLaunchPropsSchema,
  defaultProps: defaultProductLaunchProps,
  fields: [
    {
      key: "productName",
      label: "Product name",
      control: "text",
      previewFrame: 326,
    },
    {
      key: "headline",
      label: "Headline",
      control: "textarea",
      rows: 2,
      previewFrame: 42,
    },
    {
      key: "supportingCopy",
      label: "Supporting copy",
      control: "textarea",
      rows: 3,
      previewFrame: 132,
    },
    {
      key: "benefits",
      label: "Benefits (one per line)",
      control: "textarea",
      rows: 3,
      previewFrame: 252,
    },
    {
      key: "callToAction",
      label: "Call to action",
      control: "text",
      previewFrame: 336,
    },
  ],
  reviewFrames: [0, 42, 84, 132, 204, 252, 300, 336, 359],
});
