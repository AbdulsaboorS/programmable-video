import type {
  ManagedProject,
  ManagedPublication,
  ProjectRevision,
  SourceProvenance,
} from "@programmable-video/contracts";
import { Badge, Button } from "@cloudflare/kumo";
import { useRef, useState } from "react";

import { PublicationHistory } from "../PublicationHistory";
import { latestPublicationAttempt } from "./latest-publication-attempt";
import type { StudioStage, StudioStageState } from "./workspace-model";

const stageLabels = {
  draft: "Draft",
  review: "Review",
  finish: "Finish",
  published: "Published",
} satisfies Record<StudioStage, string>;

const unavailableStageCopy = {
  draft: "Draft is always available.",
  review: "Review becomes available when a draft is ready.",
  finish: "Finish becomes available after the draft is approved.",
  published: "Published becomes available after the first publish starts.",
} satisfies Record<StudioStage, string>;

const studioStages: StudioStage[] = ["draft", "review", "finish", "published"];

export function StudioStageNavigation({
  activeStage,
  stages,
  onSelect,
}: {
  activeStage: StudioStage;
  stages: Record<StudioStage, StudioStageState>;
  onSelect: (stage: StudioStage) => void;
}) {
  return (
    <ol className="studio-stage-stepper" aria-label="Video stages">
      {studioStages.map((stage, index) => {
        const state = stages[stage];
        const explanationId = `studio-stage-${stage}-explanation`;
        return (
          <li key={stage} data-state={state.complete ? "complete" : "waiting"}>
            <button
              type="button"
              disabled={!state.available}
              aria-current={activeStage === stage ? "step" : undefined}
              aria-describedby={!state.available ? explanationId : undefined}
              onClick={() => onSelect(stage)}
            >
              <span aria-hidden="true">{index + 1}</span>
              {stageLabels[stage]}
            </button>
            {!state.available && (
              <span id={explanationId} className="stage-unavailable-copy">
                {unavailableStageCopy[stage]}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export type MobileWorkspaceView = "preview" | "controls";

export function MobileWorkspaceToggle({
  value,
  onChange,
}: {
  value: MobileWorkspaceView;
  onChange: (value: MobileWorkspaceView) => void;
}) {
  return (
    <div className="mobile-workspace-toggle" aria-label="Workspace view">
      {(["preview", "controls"] as const).map((view) => (
        <button
          key={view}
          type="button"
          className="mobile-workspace-toggle-button"
          aria-pressed={value === view}
          onClick={() => onChange(view)}
        >
          {view === "preview" ? "Preview" : "Controls"}
        </button>
      ))}
    </div>
  );
}

export function TechnicalDetailsDialog({
  project,
  revisions,
  provenance,
  provenanceStatus,
  provenanceError,
  revisionBusy,
  onRetryBuild,
  onRetryProvenance,
}: {
  project: ManagedProject;
  revisions: ProjectRevision[];
  provenance: SourceProvenance | undefined;
  provenanceStatus: "idle" | "loading" | "ready" | "error";
  provenanceError: string | undefined;
  revisionBusy: string | undefined;
  onRetryBuild: (revision: ProjectRevision) => void;
  onRetryProvenance: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        aria-label="Technical details"
        onClick={() => dialogRef.current?.showModal()}
      >
        <span className="technical-details-label">Technical details</span>
        <span className="technical-details-label-short">Details</span>
      </Button>
      <dialog
        ref={dialogRef}
        className="technical-details-dialog"
        aria-labelledby="technical-details-title"
        onClick={(event) => {
          if (event.target === dialogRef.current) dialogRef.current.close();
        }}
      >
        <div className="technical-details-content">
          <header>
            <div>
              <p className="eyebrow">Project diagnostics</p>
              <h2 id="technical-details-title">Technical details</h2>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => dialogRef.current?.close()}
            >
              Close
            </Button>
          </header>

          <section aria-labelledby="technical-source-title">
            <h3 id="technical-source-title">Product source</h3>
            <dl className="source-facts">
              <div>
                <dt>Repository</dt>
                <dd>
                  <a
                    href={project.source.webUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {project.source.host}/{project.source.projectPath}
                  </a>
                </dd>
              </div>
              <div>
                <dt>Selected ref</dt>
                <dd>{project.source.selectedRef}</dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="technical-provenance-title">
            <h3 id="technical-provenance-title">Source provenance</h3>
            {provenanceStatus === "loading" && (
              <p role="status">Loading provenance</p>
            )}
            {provenanceStatus === "error" && (
              <div role="alert" className="technical-error">
                <p>
                  {provenanceError ?? "Source provenance could not be loaded."}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={onRetryProvenance}
                >
                  Retry provenance
                </Button>
              </div>
            )}
            {provenance ? (
              <pre>{provenance.markdown}</pre>
            ) : provenanceStatus === "idle" ? (
              <p>No ready draft provenance yet.</p>
            ) : null}
          </section>

          <section aria-labelledby="technical-revisions-title">
            <h3 id="technical-revisions-title">Revision and build status</h3>
            {revisions.length === 0 ? (
              <p>No revisions yet.</p>
            ) : (
              <ol className="technical-revision-list">
                {revisions.map((revision) => (
                  <li key={revision.id}>
                    <header>
                      <code title={revision.commitSha}>
                        {revision.commitSha}
                      </code>
                      <Badge
                        appearance="dot"
                        variant={
                          revision.status === "valid"
                            ? "success"
                            : revision.status === "pending"
                              ? "secondary"
                              : "error"
                        }
                      >
                        {revision.status}
                      </Badge>
                    </header>
                    <p>
                      Build: {revision.build?.status ?? "not started"}
                      {revision.build
                        ? `, attempt ${revision.build.attempt}`
                        : ""}
                    </p>
                    {revision.build &&
                      (revision.build.status === "error" ||
                        (revision.build.status === "queued" &&
                          revision.build.attempt > 1)) && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={
                            revisionBusy === `${revision.id}:build-retry`
                          }
                          disabled={revisionBusy !== undefined}
                          onClick={() => onRetryBuild(revision)}
                        >
                          {revision.build.status === "queued"
                            ? "Resume preview build"
                            : "Retry preview build"}
                        </Button>
                      )}
                    {revision.build?.checks.map((check) => (
                      <details key={check.name}>
                        <summary>
                          {check.name}: {check.status}
                        </summary>
                        {(check.stderr || check.stdout) && (
                          <pre>{check.stderr || check.stdout}</pre>
                        )}
                      </details>
                    ))}
                    {revision.findings.length > 0 && (
                      <ul>
                        {revision.findings.map((finding, index) => (
                          <li key={`${revision.id}-${index}`}>
                            <strong>{finding.code}</strong> {finding.message}
                            {finding.path
                              ? ` (${finding.path}${finding.line ? `:${finding.line}` : ""})`
                              : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </dialog>
    </>
  );
}

export function PublishedWorkspace({
  projectName,
  currentRevisionId,
  publications,
  loading,
  error,
  busyPublicationId,
  mobileView,
  onRetry,
  onPublishAnother,
}: {
  projectName: string;
  currentRevisionId?: string;
  publications: ManagedPublication[];
  loading: boolean;
  error?: string;
  busyPublicationId?: string;
  mobileView: MobileWorkspaceView;
  onRetry: (publication: ManagedPublication) => void;
  onPublishAnother: (publication: ManagedPublication) => void;
}) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const newest = publications[0];
  const featured = publications.find(
    (publication) =>
      latestPublicationAttempt(publication).playback.status === "ready",
  );
  const attempt = newest ? latestPublicationAttempt(newest) : undefined;
  const newestPlayback =
    attempt?.playback.status === "ready" ? attempt.playback : undefined;
  const featuredAttempt = featured
    ? latestPublicationAttempt(featured)
    : undefined;
  const playback =
    featuredAttempt?.playback.status === "ready"
      ? featuredAttempt.playback
      : undefined;
  const retryable =
    attempt &&
    (attempt.status === "failed" ||
      attempt.playback.status === "failed" ||
      attempt.captions.status === "failed" ||
      attempt.download.status === "failed");

  return (
    <div
      className="stage-layout published-stage-layout"
      data-mobile-view={mobileView}
    >
      <div
        className="stage-preview published-preview"
        data-mobile-active={mobileView === "preview"}
      >
        {playback && featured ? (
          <div className="published-feature">
            <div
              className="publication-player"
              style={{
                aspectRatio: `${featured.finishingSpec.output.width} / ${featured.finishingSpec.output.height}`,
              }}
            >
              <iframe
                src={playback.playerUrl}
                title={`${projectName} latest playable video`}
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
              />
            </div>
            {featured.id !== newest?.id && (
              <p className="published-preview-note" role="status">
                Showing the latest playable video while the newest version is
                not yet playable.
              </p>
            )}
          </div>
        ) : (
          <div
            className="preview-surface"
            role={loading ? "status" : undefined}
          >
            <div className="preview-surface-content">
              <strong>
                {loading
                  ? "Loading published video"
                  : newest
                    ? "Your video is being prepared"
                    : "No published video yet"}
              </strong>
              <p>
                {newest
                  ? "Delivery status updates here while the finished output is processed."
                  : "Publish an approved draft to create the first finished output."}
              </p>
            </div>
          </div>
        )}
      </div>

      <aside
        className="stage-controls published-controls"
        data-mobile-active={mobileView === "controls"}
      >
        {error && (
          <div className="revision-error" role="alert">
            Published video status: {error}
          </div>
        )}
        {newest && attempt && (
          <section className="workspace-card newest-publication">
            <p className="eyebrow">Newest output</p>
            <h2>
              {attempt.status === "ready"
                ? "Published video ready"
                : attempt.status === "failed"
                  ? "Publishing needs attention"
                  : "Publishing video"}
            </h2>
            <dl className="publication-spec">
              <div>
                <dt>Format</dt>
                <dd>{newest.finishingSpec.output.profile}</dd>
              </div>
              <div>
                <dt>Playback</dt>
                <dd>{attempt.playback.status}</dd>
              </div>
              <div>
                <dt>Download</dt>
                <dd>{attempt.download.status}</dd>
              </div>
              <div>
                <dt>Captions</dt>
                <dd>{attempt.captions.status}</dd>
              </div>
            </dl>
            <div className="publication-actions">
              {newestPlayback && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(newestPlayback.playerUrl)
                      .then(
                        () => setCopyStatus("copied"),
                        () => setCopyStatus("failed"),
                      )
                  }
                >
                  {copyStatus === "copied"
                    ? "Share link copied"
                    : "Copy share link"}
                </Button>
              )}
              {newestPlayback && (
                <a
                  href={newestPlayback.playerUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open player
                </a>
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
                  loading={busyPublicationId === newest.id}
                  disabled={busyPublicationId === newest.id}
                  onClick={() => onRetry(newest)}
                >
                  Retry publication
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                disabled={currentRevisionId !== newest.revisionId}
                onClick={() => onPublishAnother(newest)}
              >
                Publish another version
              </Button>
            </div>
            {copyStatus === "failed" && (
              <p role="alert">Could not copy the bearer share link.</p>
            )}
          </section>
        )}

        {publications.length > 1 && (
          <details className="workspace-card older-publications">
            <summary>
              Older published videos ({publications.length - 1})
            </summary>
            <PublicationHistory
              projectName={projectName}
              publications={publications.slice(1)}
              onRetry={onRetry}
              onPublishAnother={onPublishAnother}
              {...(currentRevisionId ? { currentRevisionId } : {})}
              {...(busyPublicationId ? { busyPublicationId } : {})}
            />
          </details>
        )}
      </aside>
    </div>
  );
}
