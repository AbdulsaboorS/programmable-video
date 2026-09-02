import type {
  ManagedPublication,
  ProjectRevision,
  RevisionApprovalSummary,
} from "@programmable-video/contracts";

import { latestPublicationAttempt } from "./latest-publication-attempt";

export type StudioStage = "draft" | "review" | "finish" | "published";

export interface StudioStageState {
  available: boolean;
  complete: boolean;
}

export interface StudioWorkspaceModel {
  latestRevision?: ProjectRevision;
  latestUsableDraft?: ProjectRevision;
  newerRevisionActivity: ProjectRevision[];
  exactApproval?: RevisionApprovalSummary;
  hasCurrentSourcePublication: boolean;
  newestPlayablePublication?: ManagedPublication;
  stages: Record<StudioStage, StudioStageState>;
  recommendedStage: StudioStage;
  displayRevisions: ProjectRevision[];
  displayPublications: ManagedPublication[];
}

export interface StudioWorkspaceDisplayLimits {
  revisions?: number;
  publications?: number;
}

function newestFirst<T extends { createdAt: string; id: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id),
  );
}

function limit<T>(items: T[], maximum: number | undefined): T[] {
  if (maximum === undefined) return items;
  return items.slice(0, Math.max(0, Math.trunc(maximum)));
}

function exactApprovalFor(
  revision: ProjectRevision | undefined,
): RevisionApprovalSummary | undefined {
  const build = revision?.build;
  const approval = revision?.approval;
  if (
    build?.status !== "ready" ||
    !approval ||
    approval.attempt !== build.attempt ||
    approval.manifestDigest !== build.manifestDigest ||
    approval.inputDigest !== build.inputDigest
  ) {
    return undefined;
  }
  return approval;
}

function isPlayable(publication: ManagedPublication): boolean {
  return latestPublicationAttempt(publication).playback.status === "ready";
}

export function deriveStudioWorkspace(
  revisions: readonly ProjectRevision[],
  publications: readonly ManagedPublication[],
  displayLimits: StudioWorkspaceDisplayLimits = {},
): StudioWorkspaceModel {
  const orderedRevisions = newestFirst(revisions);
  const orderedPublications = newestFirst(publications);
  const latestRevision = orderedRevisions[0];
  const latestUsableDraft = orderedRevisions.find(
    (revision) => revision.build?.status === "ready",
  );
  const draftIndex = latestUsableDraft
    ? orderedRevisions.indexOf(latestUsableDraft)
    : orderedRevisions.length;
  const newerRevisionActivity = orderedRevisions.slice(0, draftIndex);
  const exactApproval = exactApprovalFor(latestUsableDraft);
  const currentSourcePublications = exactApproval
    ? orderedPublications.filter(
        (publication) =>
          publication.revisionId === latestUsableDraft?.id &&
          publication.buildAttempt === exactApproval.attempt &&
          publication.manifestDigest === exactApproval.manifestDigest &&
          publication.inputDigest === exactApproval.inputDigest,
      )
    : [];
  const hasCurrentSourcePublication = currentSourcePublications.length > 0;
  const newestPlayablePublication = orderedPublications.find(isPlayable);

  const stages = {
    draft: { available: true, complete: latestUsableDraft !== undefined },
    review: {
      available: latestUsableDraft !== undefined,
      complete: exactApproval !== undefined,
    },
    finish: {
      available: exactApproval !== undefined,
      complete: hasCurrentSourcePublication,
    },
    published: {
      available: orderedPublications.length > 0,
      complete: hasCurrentSourcePublication,
    },
  } satisfies Record<StudioStage, StudioStageState>;

  const recommendedStage: StudioStage = hasCurrentSourcePublication
    ? "published"
    : exactApproval
      ? "finish"
      : latestUsableDraft
        ? "review"
        : "draft";

  const model: StudioWorkspaceModel = {
    newerRevisionActivity,
    hasCurrentSourcePublication,
    stages,
    recommendedStage,
    displayRevisions: limit(orderedRevisions, displayLimits.revisions),
    displayPublications: limit(orderedPublications, displayLimits.publications),
  };
  if (latestRevision) model.latestRevision = latestRevision;
  if (latestUsableDraft) model.latestUsableDraft = latestUsableDraft;
  if (exactApproval) model.exactApproval = exactApproval;
  if (newestPlayablePublication) {
    model.newestPlayablePublication = newestPlayablePublication;
  }
  return model;
}
