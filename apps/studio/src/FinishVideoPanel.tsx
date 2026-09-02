import {
  createNoOpFinishingSpec,
  finishingAudioMaxBytes,
  finishingCaptionMaxBytes,
  finishingContainBackground,
  finishingProfiles,
  finishingSpecSchema,
  type FinishingFit,
  type FinishingProfile,
  type FinishingSpec,
  type ManagedPublication,
  type ManagedVideoSpec,
  type ProjectMediaAsset,
  videoSpec,
} from "@programmable-video/contracts";
import { Button } from "@cloudflare/kumo";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentType,
} from "react";

import {
  FinishedOutputPreview,
  type FinishedOutputPreviewProps,
} from "./FinishedOutputPreview";
import {
  createPublication,
  loadProjectMedia,
  uploadProjectAudio,
  uploadProjectCaptions,
  validateProjectAudio,
} from "./project-api";

export interface FinishVideoPanelOperations {
  createPublication: typeof createPublication;
  loadProjectMedia: typeof loadProjectMedia;
  uploadProjectAudio: typeof uploadProjectAudio;
  uploadProjectCaptions: typeof uploadProjectCaptions;
  validateProjectAudio: typeof validateProjectAudio;
}

const defaultOperations: FinishVideoPanelOperations = {
  createPublication,
  loadProjectMedia,
  uploadProjectAudio,
  uploadProjectCaptions,
  validateProjectAudio,
};

interface FinishVideoPanelProps {
  commitSha?: string;
  durationInFrames?: ManagedVideoSpec["durationInFrames"];
  mobileView?: "preview" | "controls";
  projectId: string;
  projectName: string;
  revisionId?: string;
  onPublicationCreated: (publication: ManagedPublication) => void;
  requestedSpec?: { key: string; spec: FinishingSpec };
  operations?: FinishVideoPanelOperations;
  PreviewComponent?: ComponentType<FinishedOutputPreviewProps>;
}

function mergeMedia(
  current: ProjectMediaAsset[],
  incoming: ProjectMediaAsset[],
): ProjectMediaAsset[] {
  const validationRank = { pending: 0, invalid: 1, valid: 2 } as const;
  return incoming.reduce((merged, asset) => {
    const existing = merged.find((item) => item.id === asset.id);
    if (
      !existing ||
      validationRank[asset.validationStatus] >=
        validationRank[existing.validationStatus]
    ) {
      return [asset, ...merged.filter((item) => item.id !== asset.id)];
    }
    return merged;
  }, current);
}

export function FinishVideoPanel({
  commitSha,
  durationInFrames,
  mobileView = "preview",
  projectId,
  revisionId,
  onPublicationCreated,
  requestedSpec,
  operations = defaultOperations,
  PreviewComponent = FinishedOutputPreview,
}: FinishVideoPanelProps) {
  const [spec, setSpec] = useState<FinishingSpec>(() =>
    createNoOpFinishingSpec(durationInFrames ?? videoSpec.durationInFrames),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [media, setMedia] = useState<ProjectMediaAsset[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [uploading, setUploading] = useState<"audio" | "captions">();
  const [validatingAudioId, setValidatingAudioId] = useState<string>();
  const [error, setError] = useState<string>();
  const [mediaError, setMediaError] = useState<string>();
  const [previewStatus, setPreviewStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const intentKeyRef = useRef(crypto.randomUUID());
  const loadMedia = operations.loadProjectMedia;

  const updateSpec = (next: FinishingSpec) => {
    setSpec(next);
    setConfirmed(false);
    intentKeyRef.current = crypto.randomUUID();
  };

  useEffect(() => {
    setSpec(
      createNoOpFinishingSpec(durationInFrames ?? videoSpec.durationInFrames),
    );
    setConfirmed(false);
    setMedia([]);
    setError(undefined);
    setMediaError(undefined);
    setPreviewStatus("loading");
    intentKeyRef.current = crypto.randomUUID();
  }, [durationInFrames, projectId, revisionId]);

  useEffect(() => {
    if (!requestedSpec) return;
    setSpec(requestedSpec.spec);
    setConfirmed(false);
    setError(undefined);
    intentKeyRef.current = crypto.randomUUID();
  }, [requestedSpec]);

  useEffect(() => {
    if (!revisionId) return;
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const refresh = async () => {
      controller = new AbortController();
      try {
        const nextMedia = await loadMedia(projectId, controller.signal);
        if (!active) return;
        setMedia((current) => mergeMedia(current, nextMedia));
        setMediaError(undefined);
      } catch (requestError) {
        if (active && !controller.signal.aborted)
          setMediaError(
            requestError instanceof Error
              ? requestError.message
              : "Request failed",
          );
      } finally {
        if (active) timer = window.setTimeout(() => void refresh(), 3_000);
      }
    };
    void refresh();
    return () => {
      active = false;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadMedia, projectId, revisionId]);

  const validAudio = media.filter(
    (asset) => asset.kind === "audio" && asset.validationStatus === "valid",
  );
  const validCaptions = media.filter(
    (asset) => asset.kind === "captions" && asset.validationStatus === "valid",
  );
  const selectedAudio =
    spec.audio === null
      ? undefined
      : validAudio.find((asset) => asset.id === spec.audio?.asset.id);

  const setProfile = (profile: FinishingProfile) => {
    const output =
      profile === "landscape"
        ? { profile, ...finishingProfiles.landscape }
        : profile === "square"
          ? { profile, ...finishingProfiles.square }
          : { profile, ...finishingProfiles.portrait };
    updateSpec({
      ...spec,
      output: {
        ...output,
        fit: spec.output.fit,
        containBackground: finishingContainBackground,
      },
    });
  };

  const setFit = (fit: FinishingFit) => {
    updateSpec({ ...spec, output: { ...spec.output, fit } });
  };

  const setAudio = (assetId: string) => {
    const asset = validAudio.find((item) => item.id === assetId);
    updateSpec({
      ...spec,
      audio: asset
        ? {
            asset: { id: asset.id, sha256: asset.sha256 },
            gainPercent: spec.audio?.gainPercent ?? 100,
          }
        : null,
      captions:
        !asset && spec.captions.mode === "generated"
          ? { mode: "none" }
          : spec.captions,
    });
  };

  const upload = async (
    kind: "audio" | "captions",
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setConfirmed(false);
    if (
      (kind === "audio" && file.size > finishingAudioMaxBytes) ||
      (kind === "captions" && file.size > finishingCaptionMaxBytes)
    ) {
      setError(
        kind === "audio" ? "Audio exceeds 25 MiB" : "Captions exceed 1 MiB",
      );
      return;
    }
    setUploading(kind);
    setError(undefined);
    try {
      const asset =
        kind === "audio"
          ? await operations.uploadProjectAudio(projectId, file)
          : await operations.uploadProjectCaptions(projectId, file);
      setMedia((current) => [
        asset,
        ...current.filter((item) => item.id !== asset.id),
      ]);
      if (asset.kind === "audio" && asset.validationStatus === "valid") {
        updateSpec({
          ...spec,
          audio: {
            asset: { id: asset.id, sha256: asset.sha256 },
            gainPercent: spec.audio?.gainPercent ?? 100,
          },
        });
      }
      if (asset.kind === "captions" && asset.validationStatus === "valid") {
        updateSpec({
          ...spec,
          captions: {
            mode: "uploaded",
            language: "en",
            asset: { id: asset.id, sha256: asset.sha256 },
          },
        });
      }
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "Request failed",
      );
    } finally {
      setUploading(undefined);
    }
  };

  const retryAudioValidation = async (asset: ProjectMediaAsset) => {
    if (asset.kind !== "audio") return;
    setConfirmed(false);
    setValidatingAudioId(asset.id);
    setError(undefined);
    try {
      const validated = await operations.validateProjectAudio(
        projectId,
        asset.id,
      );
      setMedia((current) => mergeMedia(current, [validated]));
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "Request failed",
      );
    } finally {
      setValidatingAudioId(undefined);
    }
  };

  const publish = async () => {
    if (!revisionId) return;
    const parsed = finishingSpecSchema.safeParse(spec);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check finishing settings");
      return;
    }
    setPublishing(true);
    setError(undefined);
    try {
      const publication = await operations.createPublication(
        projectId,
        revisionId,
        {
          idempotencyKey: intentKeyRef.current,
          finishingSpec: parsed.data,
        },
      );
      onPublicationCreated(publication);
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "Request failed",
      );
    } finally {
      setPublishing(false);
    }
  };

  const frameCount = spec.trim.endFrame - spec.trim.startFrame;

  return (
    <>
      {revisionId && commitSha && durationInFrames && (
        <div
          className="stage-preview finish-preview"
          data-mobile-active={mobileView === "preview"}
        >
          <PreviewComponent
            projectId={projectId}
            revisionId={revisionId}
            commitSha={commitSha}
            finishingSpec={spec}
            onStatusChange={(status) => {
              setPreviewStatus(status);
              if (status !== "ready") setConfirmed(false);
            }}
          />
        </div>
      )}

      <aside
        className="stage-controls finish-controls"
        data-mobile-active={mobileView === "controls"}
      >
        {error && (
          <div className="finish-error" role="alert">
            {error}
          </div>
        )}
        {revisionId && commitSha && durationInFrames ? (
          <section id="finish-video-settings" className="finish-settings">
            <div className="finish-section-heading">
              <div>
                <span>Approved source {commitSha.slice(0, 8)}</span>
                <h3>Finish video</h3>
              </div>
              <strong>{(frameCount / videoSpec.fps).toFixed(2)}s</strong>
            </div>

            {mediaError && (
              <div className="finish-error" role="alert">
                Media status may be stale: {mediaError}
              </div>
            )}

            <fieldset className="finish-control-group">
              <legend>Trim</legend>
              <div className="trim-fields">
                <label>
                  Start frame
                  <input
                    type="number"
                    min={0}
                    max={spec.trim.endFrame - 1}
                    value={spec.trim.startFrame}
                    onChange={(event) =>
                      updateSpec({
                        ...spec,
                        trim: {
                          ...spec.trim,
                          startFrame: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  End frame (exclusive)
                  <input
                    type="number"
                    min={spec.trim.startFrame + 1}
                    max={durationInFrames}
                    value={spec.trim.endFrame}
                    onChange={(event) =>
                      updateSpec({
                        ...spec,
                        trim: {
                          ...spec.trim,
                          endFrame: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
              </div>
              <p>
                Includes frames {spec.trim.startFrame} through{" "}
                {spec.trim.endFrame - 1}. Frame {spec.trim.endFrame} is not
                rendered.
              </p>
            </fieldset>

            <fieldset className="finish-control-group">
              <legend>Format</legend>
              <div className="choice-grid three">
                {(["landscape", "square", "portrait"] as const).map(
                  (profile) => (
                    <label key={profile}>
                      <input
                        type="radio"
                        name="finishing-profile"
                        checked={spec.output.profile === profile}
                        onChange={() => setProfile(profile)}
                      />
                      <strong>{profile}</strong>
                      <span>
                        {finishingProfiles[profile].width}x
                        {finishingProfiles[profile].height}
                      </span>
                    </label>
                  ),
                )}
              </div>
              <div className="choice-grid">
                {(["contain", "cover"] as const).map((fit) => (
                  <label key={fit}>
                    <input
                      type="radio"
                      name="finishing-fit"
                      checked={spec.output.fit === fit}
                      onChange={() => setFit(fit)}
                    />
                    <strong>{fit}</strong>
                    <span>
                      {fit === "contain"
                        ? "Preserve all approved UI"
                        : "Crop edges from the center"}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {spec.output.fit === "cover" && (
              <div className="cover-warning" role="note">
                <strong>Cover crops approved pixels</strong>
                <span>
                  Confirm the preview after checking that important UI remains
                  visible.
                </span>
              </div>
            )}

            <details className="finish-control-group">
              <summary>Audio</summary>
              <label className="finish-select-field">
                Selected audio
                <select
                  value={spec.audio?.asset.id ?? ""}
                  onChange={(event) => setAudio(event.target.value)}
                >
                  <option value="">No audio</option>
                  {validAudio.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.fileName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="media-upload">
                {uploading === "audio"
                  ? "Uploading audio..."
                  : "Upload MP3, WAV, or M4A"}
                <input
                  type="file"
                  accept="audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a"
                  disabled={uploading !== undefined}
                  onChange={(event) => void upload("audio", event)}
                />
              </label>
              {spec.audio && (
                <div className="selected-audio-preview">
                  {selectedAudio && (
                    <audio
                      controls
                      preload="metadata"
                      src={`/api/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(selectedAudio.id)}/content`}
                    >
                      Audio preview is not supported by this browser.
                    </audio>
                  )}
                  <label className="gain-control">
                    Publication volume: {spec.audio.gainPercent}%
                    <input
                      aria-label="Audio gain"
                      type="range"
                      min="0"
                      max="100"
                      value={spec.audio.gainPercent}
                      onChange={(event) =>
                        updateSpec({
                          ...spec,
                          audio: spec.audio
                            ? {
                                ...spec.audio,
                                gainPercent: Number(event.target.value),
                              }
                            : null,
                        })
                      }
                    />
                  </label>
                </div>
              )}
              {media.some((asset) => asset.kind === "audio") && (
                <ul className="media-list" aria-label="Uploaded audio">
                  {media
                    .filter((asset) => asset.kind === "audio")
                    .map((asset) => (
                      <li key={asset.id}>
                        <span>
                          {asset.fileName}
                          {asset.validationError && (
                            <small>{asset.validationError}</small>
                          )}
                        </span>
                        <strong>{asset.validationStatus}</strong>
                        {asset.validationStatus !== "valid" && (
                          <button
                            type="button"
                            disabled={validatingAudioId !== undefined}
                            onClick={() => void retryAudioValidation(asset)}
                          >
                            {validatingAudioId === asset.id
                              ? "Validating..."
                              : "Retry validation"}
                          </button>
                        )}
                      </li>
                    ))}
                </ul>
              )}
            </details>

            <details className="finish-control-group">
              <summary>Captions</summary>
              <label className="finish-select-field">
                Caption source
                <select
                  value={
                    spec.captions.mode === "uploaded"
                      ? `uploaded:${spec.captions.asset.id}`
                      : spec.captions.mode
                  }
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "none") {
                      updateSpec({ ...spec, captions: { mode: "none" } });
                    } else if (value === "generated") {
                      updateSpec({
                        ...spec,
                        captions: { mode: "generated", language: "en" },
                      });
                    } else {
                      const asset = validCaptions.find(
                        (item) => item.id === value.slice("uploaded:".length),
                      );
                      if (asset) {
                        updateSpec({
                          ...spec,
                          captions: {
                            mode: "uploaded",
                            language: "en",
                            asset: { id: asset.id, sha256: asset.sha256 },
                          },
                        });
                      }
                    }
                  }}
                >
                  <option value="none">No captions</option>
                  {validCaptions.map((asset) => (
                    <option key={asset.id} value={`uploaded:${asset.id}`}>
                      Uploaded: {asset.fileName}
                    </option>
                  ))}
                  <option value="generated" disabled={!selectedAudio}>
                    Generate from uploaded audio
                  </option>
                </select>
              </label>
              {!selectedAudio && (
                <p>
                  Generated captions require a validated uploaded audio track.
                </p>
              )}
              <label className="media-upload">
                {uploading === "captions"
                  ? "Uploading captions..."
                  : "Upload English WebVTT"}
                <input
                  type="file"
                  accept="text/vtt,.vtt"
                  disabled={uploading !== undefined}
                  onChange={(event) => void upload("captions", event)}
                />
              </label>
              {media.some((asset) => asset.kind === "captions") && (
                <ul className="media-list" aria-label="Uploaded captions">
                  {media
                    .filter((asset) => asset.kind === "captions")
                    .map((asset) => (
                      <li key={asset.id}>
                        <span>
                          {asset.fileName}
                          {asset.validationError && (
                            <small>{asset.validationError}</small>
                          )}
                        </span>
                        <strong>{asset.validationStatus}</strong>
                      </li>
                    ))}
                </ul>
              )}
            </details>

            <label className="finished-confirmation">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={
                  previewStatus !== "ready" ||
                  uploading !== undefined ||
                  validatingAudioId !== undefined
                }
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {previewStatus === "ready"
                ? "I checked the framing and trim shown in this preview."
                : previewStatus === "error"
                  ? "Resolve the preview error before confirming framing and trim."
                  : "Wait for the framing and trim preview before confirming."}
            </label>
            <Button
              variant="primary"
              loading={publishing}
              disabled={
                !confirmed ||
                previewStatus !== "ready" ||
                publishing ||
                uploading !== undefined ||
                validatingAudioId !== undefined
              }
              onClick={() => void publish()}
            >
              Publish video
            </Button>
            <p className="publish-intent-note">
              Repeating an unchanged request safely reuses the same publish
              intent.
            </p>
          </section>
        ) : (
          <div className="render-progress" role="status">
            <span className="activity-dot" />
            <div>
              <strong>Loading finishing controls</strong>
              <p>The approved preview is reporting its exact duration.</p>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
