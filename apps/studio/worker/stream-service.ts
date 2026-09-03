import { z } from "zod";

const apiOrigin = "https://api.cloudflare.com/client/v4";
const requestTimeoutMs = 60_000;
const apiEnvelopeSchema = z
  .object({
    success: z.boolean(),
    errors: z
      .array(z.object({ message: z.string().optional() }).passthrough())
      .default([]),
    result: z.unknown(),
  })
  .passthrough();
const directUploadSchema = z.object({
  uid: z.string().min(1),
  uploadURL: z.url(),
});
const videoSchema = z.object({
  uid: z.string().min(1),
  readyToStream: z.boolean().default(false),
  status: z.object({ state: z.string() }),
  preview: z.url().optional(),
  thumbnail: z.url().optional(),
  playback: z.object({ hls: z.url().optional() }).optional(),
});
const captionSchema = z.object({
  generated: z.boolean().optional(),
  label: z.string().default(""),
  language: z.string(),
  status: z.enum(["ready", "inprogress", "error"]).optional(),
});
const downloadsSchema = z.object({
  audio: downloadSchema().optional(),
  default: downloadSchema().optional(),
});

interface PublicationVideoDetails {
  id: string;
  readyToStream: boolean;
  status: { state: string };
  preview?: string;
  thumbnail: string;
  hlsPlaybackUrl: string;
}

function downloadSchema() {
  return z.object({
    percentComplete: z.number().min(0).max(100),
    status: z.enum(["ready", "inprogress", "error"]),
    url: z.url().optional(),
  });
}

function mapCaption(parsed: z.output<typeof captionSchema>): StreamCaption {
  const caption: StreamCaption = {
    label: parsed.label,
    language: parsed.language,
  };
  if (parsed.generated !== undefined) caption.generated = parsed.generated;
  if (parsed.status !== undefined) caption.status = parsed.status;
  return caption;
}

function mapDownloads(
  parsed: z.output<typeof downloadsSchema>,
): StreamDownloadGetResponse {
  const downloads: StreamDownloadGetResponse = {};
  for (const type of ["audio", "default"] as const) {
    const parsedDownload = parsed[type];
    if (!parsedDownload) continue;
    const download: StreamDownload = {
      percentComplete: parsedDownload.percentComplete,
      status: parsedDownload.status,
    };
    if (parsedDownload.url !== undefined) download.url = parsedDownload.url;
    downloads[type] = download;
  }
  return downloads;
}

export interface PublicationStreamService {
  createDirectUpload(
    params: StreamDirectUploadCreateParams,
  ): Promise<{ id: string; uploadURL: string }>;
  video(id: string): {
    details(): Promise<PublicationVideoDetails>;
    captions: Pick<
      StreamScopedCaptions,
      "upload" | "generate" | "list" | "delete"
    >;
    downloads: Pick<StreamScopedDownloads, "generate" | "get" | "delete">;
  };
}

interface StreamServiceEnv {
  STREAM: StreamBinding;
  STREAM_ACCOUNT_ID?: string;
  STREAM_API_TOKEN?: string;
}

export function publicationStreamService(
  env: StreamServiceEnv,
): PublicationStreamService {
  const accountId = env.STREAM_ACCOUNT_ID?.trim();
  const apiToken = env.STREAM_API_TOKEN?.trim();
  if (!accountId && !apiToken) return env.STREAM;
  if (!accountId || !apiToken) {
    throw new Error(
      "STREAM_ACCOUNT_ID and STREAM_API_TOKEN must be configured together",
    );
  }
  return createRestStreamService(accountId, apiToken);
}

export function createRestStreamService(
  accountId: string,
  apiToken: string,
  fetcher: typeof fetch = fetch,
): PublicationStreamService {
  const base = `${apiOrigin}/accounts/${encodeURIComponent(accountId)}/stream`;
  const request = async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${apiToken}`);
    const response = await fetcher(`${base}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const parsed = apiEnvelopeSchema.safeParse(
      await response.json().catch(() => undefined),
    );
    if (!response.ok || !parsed.success || !parsed.data.success) {
      const detail = parsed.success
        ? parsed.data.errors[0]?.message
        : undefined;
      throw new Error(
        `Stream API request failed (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    return parsed.data.result;
  };
  const videoPath = (id: string) => `/${encodeURIComponent(id)}`;

  return {
    async createDirectUpload(params) {
      const result = directUploadSchema.parse(
        await request("/direct_upload", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
        }),
      );
      return { id: result.uid, uploadURL: result.uploadURL };
    },
    video(id) {
      const path = videoPath(id);
      return {
        async details() {
          const result = videoSchema.parse(await request(path));
          const details: PublicationVideoDetails = {
            id: result.uid,
            readyToStream: result.readyToStream,
            status: result.status,
            thumbnail: result.thumbnail ?? "",
            hlsPlaybackUrl: result.playback?.hls ?? "",
          };
          if (result.preview) details.preview = result.preview;
          return details;
        },
        captions: {
          async upload(language, input) {
            const form = new FormData();
            form.set("file", await new Response(input).blob(), "captions.vtt");
            return mapCaption(
              captionSchema.parse(
                await request(
                  `${path}/captions/${encodeURIComponent(language)}`,
                  {
                    method: "PUT",
                    body: form,
                  },
                ),
              ),
            );
          },
          async generate(language) {
            return mapCaption(
              captionSchema.parse(
                await request(
                  `${path}/captions/${encodeURIComponent(language)}/generate`,
                  { method: "POST" },
                ),
              ),
            );
          },
          async list(language) {
            if (language) {
              return [
                mapCaption(
                  captionSchema.parse(
                    await request(
                      `${path}/captions/${encodeURIComponent(language)}`,
                    ),
                  ),
                ),
              ];
            }
            return z
              .array(captionSchema)
              .parse(await request(`${path}/captions`))
              .map(mapCaption);
          },
          async delete(language) {
            await request(`${path}/captions/${encodeURIComponent(language)}`, {
              method: "DELETE",
            });
          },
        },
        downloads: {
          async generate(downloadType) {
            return mapDownloads(
              downloadsSchema.parse(
                await request(
                  `${path}/downloads${downloadType ? `/${downloadType}` : ""}`,
                  { method: "POST" },
                ),
              ),
            );
          },
          async get() {
            return mapDownloads(
              downloadsSchema.parse(await request(`${path}/downloads`)),
            );
          },
          async delete(downloadType) {
            await request(
              `${path}/downloads${downloadType ? `/${downloadType}` : ""}`,
              { method: "DELETE" },
            );
          },
        },
      };
    },
  };
}
