import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import {
  createRestStreamService,
  publicationStreamService,
} from "./stream-service";

describe("publication Stream service", () => {
  it("uses the native binding when REST credentials are absent", () => {
    const stream = fromPartial<StreamBinding>({ video: vi.fn() });
    expect(publicationStreamService({ STREAM: stream })).toBe(stream);
  });

  it("rejects partial REST configuration", () => {
    expect(() =>
      publicationStreamService({
        STREAM: fromPartial<StreamBinding>({}),
        STREAM_ACCOUNT_ID: "account",
      }),
    ).toThrow("must be configured together");
  });

  it("creates a direct upload without exposing the API token", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        success: true,
        errors: [],
        result: { uid: "video-id", uploadURL: "https://upload.example/video" },
      }),
    );
    const service = createRestStreamService(
      "account/id",
      "secret-token",
      fetcher,
    );

    await expect(
      service.createDirectUpload({
        maxDurationSeconds: 60,
        meta: { name: "Demo" },
      }),
    ).resolves.toEqual({
      id: "video-id",
      uploadURL: "https://upload.example/video",
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account%2Fid/stream/direct_upload",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer secret-token",
    );
    expect(init?.body).not.toContain("secret-token");
  });

  it("maps video and download responses to the binding contract", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          errors: [],
          result: {
            uid: "video-id",
            readyToStream: true,
            status: { state: "ready" },
            preview: "https://watch.example/video",
            thumbnail: "https://watch.example/thumb.jpg",
            playback: { hls: "https://watch.example/video.m3u8" },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          errors: [],
          result: {
            default: {
              status: "ready",
              percentComplete: 100,
              url: "https://watch.example/video.mp4",
            },
          },
        }),
      );
    const video = createRestStreamService("account", "token", fetcher).video(
      "video/id",
    );

    await expect(video.details()).resolves.toMatchObject({
      id: "video-id",
      hlsPlaybackUrl: "https://watch.example/video.m3u8",
    });
    await expect(video.downloads.get()).resolves.toEqual({
      default: {
        status: "ready",
        percentComplete: 100,
        url: "https://watch.example/video.mp4",
      },
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/account/stream/video%2Fid",
      "https://api.cloudflare.com/client/v4/accounts/account/stream/video%2Fid/downloads",
    ]);
  });

  it("returns bounded API failures without credentials", async () => {
    const service = createRestStreamService(
      "account",
      "secret-token",
      vi.fn(async () =>
        Response.json(
          {
            success: false,
            errors: [{ message: "Permission denied" }],
            result: null,
          },
          { status: 403 },
        ),
      ),
    );

    await expect(service.video("video").details()).rejects.toThrow(
      "Stream API request failed (403): Permission denied",
    );
  });
});
