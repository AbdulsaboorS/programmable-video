import {
  managedVideoSpecSchema,
  type ManagedVideoSpec,
} from "@programmable-video/contracts";

export function parseRevisionVideoSpec(bytes: Uint8Array): ManagedVideoSpec {
  return managedVideoSpecSchema.parse(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
}
