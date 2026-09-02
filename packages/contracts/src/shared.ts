import { z } from "zod";

export const isoTimestampSchema = z.iso.datetime({ offset: true });
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
