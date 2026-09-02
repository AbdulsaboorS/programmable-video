import type {
  ManagedPublication,
  PublicationAttempt,
} from "@programmable-video/contracts";
import { Button } from "@cloudflare/kumo";
import { useState } from "react";

import { latestPublicationAttempt } from "./studio/latest-publication-attempt";

interface PublicationHistoryProps {
  busyPublicationId?: string;
  currentRevisionId?: string;
  projectName: string;
  publications: ManagedPublication[];
  onPublishAnother: (publication: ManagedPublication) => void;
  onRetry: (publication: ManagedPublication) => void;
}

function statusText(attempt: PublicationAttempt): string {
  if (attempt.status === "failed") return attempt.error ?? "Processing failed";
  if (attempt.status === "ready") return "Master ready";
  return attempt.status === "queued" ? "Waiting to start" : "Rendering master";
}

export function PublicationCard({
  busy,
  canPublishAnother,
  projectName,
  publication,
  onPublishAnother,
  onRetry,
}: {
  busy: boolean;
  canPublishAnother: boolean;
  projectName: string;
  publication: ManagedPublication;
  onPublishAnother: (publication: ManagedPublication) => void;
  onRetry: (publication: ManagedPublication) => void;
}) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const attempt = latestPublicationAttempt(publication);
  const { finishingSpec } = publication;
  const playback =
    attempt.playback.status === "ready" ? attempt.playback : undefined;
  const retryable =
    attempt.status === "failed" ||
    attempt.playback.status === "failed" ||
    attempt.captions.status === "failed" ||
    attempt.download.status === "failed";

  const copyShareLink = async () => {
    if (!playback) return;
    try {
      await navigator.clipboard.writeText(playback.playerUrl);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  return (
    <article className="publication-card">
      <header>
        <div>
          <span>Publication {publication.id.slice(0, 8)}</span>
          <strong>{statusText(attempt)}</strong>
        </div>
        <time dateTime={publication.createdAt}>
          {new Date(publication.createdAt).toLocaleString()}
        </time>
      </header>

      <dl className="publication-spec">
        <div>
          <dt>Source</dt>
          <dd>{publication.revisionId.slice(0, 8)}</dd>
        </div>
        <div>
          <dt>Trim</dt>
          <dd>
            [{finishingSpec.trim.startFrame}, {finishingSpec.trim.endFrame})
          </dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>
            {finishingSpec.output.profile}, {finishingSpec.output.fit}
          </dd>
        </div>
        <div>
          <dt>Audio</dt>
          <dd>
            {finishingSpec.audio
              ? `${finishingSpec.audio.gainPercent}% gain`
              : "None"}
          </dd>
        </div>
        <div>
          <dt>Captions</dt>
          <dd>{finishingSpec.captions.mode}</dd>
        </div>
      </dl>

      <div
        className="delivery-states"
        aria-label="Delivery status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span>Playback: {attempt.playback.status}</span>
        <span>Captions: {attempt.captions.status}</span>
        <span>
          Download: {attempt.download.status}
          {attempt.download.status === "processing" &&
          attempt.download.percentComplete !== null
            ? ` (${Math.round(attempt.download.percentComplete)}%)`
            : ""}
        </span>
      </div>

      {playback && (
        <div
          className="publication-player"
          style={{
            aspectRatio: `${finishingSpec.output.width} / ${finishingSpec.output.height}`,
          }}
        >
          <iframe
            src={playback.playerUrl}
            title={`${projectName} publication ${publication.id.slice(0, 8)}`}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
          />
        </div>
      )}

      <div className="publication-actions">
        {playback && (
          <Button size="sm" variant="secondary" onClick={copyShareLink}>
            {copyStatus === "copied" ? "Share link copied" : "Copy share link"}
          </Button>
        )}
        {playback && (
          <a href={playback.playerUrl} target="_blank" rel="noreferrer">
            Open player
          </a>
        )}
        {copyStatus === "failed" && (
          <span role="alert">Could not copy the bearer share link.</span>
        )}
        {attempt.download.status === "ready" && (
          <a href={attempt.download.url} download>
            Download MP4
          </a>
        )}
        {retryable && (
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            disabled={busy}
            onClick={() => onRetry(publication)}
          >
            Retry publication
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={!canPublishAnother}
          onClick={() => onPublishAnother(publication)}
        >
          Publish another version
        </Button>
        {!canPublishAnother && (
          <span className="publication-source-note">
            Select approved source {publication.revisionId.slice(0, 8)} to copy
            these settings.
          </span>
        )}
      </div>
      {playback && (
        <p className="bearer-link-note">
          Anyone with the Stream player link can view this internal-beta video.
        </p>
      )}
    </article>
  );
}

export function PublicationHistory({
  busyPublicationId,
  currentRevisionId,
  projectName,
  publications,
  onPublishAnother,
  onRetry,
}: PublicationHistoryProps) {
  return (
    <section
      className="publication-history"
      aria-labelledby="publication-history-title"
    >
      <div className="finish-section-heading">
        <div>
          <span>Immutable outputs</span>
          <h3 id="publication-history-title">Publication history</h3>
        </div>
        <strong>{publications.length}</strong>
      </div>
      {publications.length === 0 ? (
        <p className="publication-loading">
          No publications for this project yet.
        </p>
      ) : (
        <div className="publication-list">
          {publications.map((publication) => (
            <PublicationCard
              key={publication.id}
              publication={publication}
              projectName={projectName}
              busy={busyPublicationId === publication.id}
              canPublishAnother={currentRevisionId === publication.revisionId}
              onRetry={onRetry}
              onPublishAnother={onPublishAnother}
            />
          ))}
        </div>
      )}
    </section>
  );
}
