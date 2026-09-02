import {
  defineCompositionManifest,
  videoSpec,
} from "@programmable-video/contracts";
import { z } from "zod";

export const supportAgentPropsSchema = z
  .object({
    customerName: z.string().trim().min(1).max(80),
    companyName: z.string().trim().min(1).max(80),
    hostname: z.string().trim().min(1).max(120),
    location: z.string().trim().min(1).max(80),
    issue: z.string().trim().min(1).max(280),
  })
  .strict();

export type SupportAgentProps = z.infer<typeof supportAgentPropsSchema>;

export const defaultSupportAgentProps = {
  customerName: "Mara",
  companyName: "Northstar Labs",
  hostname: "api.northstar.example",
  location: "Singapore",
  issue: "intermittent 522 responses",
} satisfies SupportAgentProps;

export const supportAgentManifest = defineCompositionManifest({
  id: "support-agent",
  label: "Support agent",
  description: "Turn a support request into an evidence-backed response.",
  spec: videoSpec,
  propsSchema: supportAgentPropsSchema,
  defaultProps: defaultSupportAgentProps,
  fields: [
    {
      key: "customerName",
      label: "Customer name",
      control: "text",
      previewFrame: 359,
    },
    {
      key: "companyName",
      label: "Company name",
      control: "text",
      previewFrame: 359,
    },
    {
      key: "hostname",
      label: "Hostname",
      control: "text",
      previewFrame: 220,
    },
    {
      key: "location",
      label: "Location",
      control: "text",
      previewFrame: 220,
    },
    {
      key: "issue",
      label: "Issue",
      control: "textarea",
      rows: 3,
      previewFrame: 359,
    },
  ],
  reviewFrames: [0, 36, 75, 120, 180, 220, 255, 320, 359],
});
