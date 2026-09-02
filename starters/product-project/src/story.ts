import { z } from "zod";

export const videoSpec = {
  width: 1280,
  height: 720,
  fps: 30,
  durationInFrames: 360,
} as const;

export const productStorySchema = z
  .object({
    productName: z.string().trim().min(1).max(60),
    headline: z.string().trim().min(1).max(100),
    detail: z.string().trim().min(1).max(180),
    callToAction: z.string().trim().min(1).max(40),
  })
  .strict();

export type ProductStory = z.infer<typeof productStorySchema>;

export const defaultStory: ProductStory = {
  productName: "Product",
  headline: "Show the product outcome",
  detail:
    "Replace this synthetic interface with a faithful, reusable film set built from the supplied product context.",
  callToAction: "Start creating",
};
