import { z } from "zod";

import { videoSpec, type VideoSpec } from "./video-spec";

export type FlatStringPropsSchema = z.ZodObject<Record<string, z.ZodString>>;

type FieldKey<Schema extends FlatStringPropsSchema> = Extract<
  keyof z.output<Schema>,
  string
>;

type CompositionFieldBase<Schema extends FlatStringPropsSchema> = {
  key: FieldKey<Schema>;
  label: string;
  previewFrame: number;
};

export type CompositionField<Schema extends FlatStringPropsSchema> =
  | (CompositionFieldBase<Schema> & {
      control: "text";
    })
  | (CompositionFieldBase<Schema> & {
      control: "textarea";
      rows?: number;
    });

export type CompositionManifest<
  Schema extends FlatStringPropsSchema = FlatStringPropsSchema,
  Id extends string = string,
> = {
  id: Id;
  label: string;
  description: string;
  spec: VideoSpec;
  propsSchema: Schema;
  defaultProps: Readonly<z.output<Schema>>;
  fields: readonly CompositionField<Schema>[];
  reviewFrames: readonly number[];
};

export type InferCompositionProps<Manifest extends CompositionManifest> =
  z.output<Manifest["propsSchema"]>;

function assertFrame(frame: number, description: string): void {
  if (
    !Number.isInteger(frame) ||
    frame < 0 ||
    frame >= videoSpec.durationInFrames
  ) {
    throw new Error(
      `${description} must be an integer from 0 to ${videoSpec.durationInFrames - 1}`,
    );
  }
}

export function defineCompositionManifest<
  const Schema extends FlatStringPropsSchema,
  const Id extends string,
>(manifest: CompositionManifest<Schema, Id>): CompositionManifest<Schema, Id> {
  if (
    manifest.id.trim().length === 0 ||
    manifest.label.trim().length === 0 ||
    manifest.description.trim().length === 0
  ) {
    throw new Error("Composition ID, label, and description are required");
  }
  if (manifest.spec !== videoSpec) {
    throw new Error(`Composition ${manifest.id} must use the fixed video spec`);
  }

  const parsedDefaults = manifest.propsSchema.parse(manifest.defaultProps);
  if (
    manifest.propsSchema.safeParse({
      ...parsedDefaults,
      __unknownCompositionProp: "rejected",
    }).success
  ) {
    throw new Error(`Composition ${manifest.id} props schema must be strict`);
  }

  const schemaKeys = manifest.propsSchema.keyof().options;

  const fieldKeys = manifest.fields.map((field) => field.key);
  if (
    fieldKeys.length !== schemaKeys.length ||
    new Set(fieldKeys).size !== fieldKeys.length ||
    fieldKeys.some((key, index) => key !== schemaKeys[index])
  ) {
    throw new Error(
      `Composition ${manifest.id} fields must match schema keys in order`,
    );
  }

  for (const field of manifest.fields) {
    if (field.label.trim().length === 0) {
      throw new Error(`Field label for ${String(field.key)} is required`);
    }
    assertFrame(field.previewFrame, `Preview frame for ${String(field.key)}`);
    if (
      field.control === "textarea" &&
      field.rows !== undefined &&
      (!Number.isInteger(field.rows) || field.rows < 1)
    ) {
      throw new Error(
        `Textarea rows for ${String(field.key)} must be positive`,
      );
    }
  }

  if (manifest.reviewFrames.length === 0) {
    throw new Error(`Composition ${manifest.id} must declare review frames`);
  }
  for (const frame of manifest.reviewFrames) {
    assertFrame(frame, `Review frame for ${manifest.id}`);
  }

  return manifest;
}
