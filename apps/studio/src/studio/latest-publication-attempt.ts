import type {
  ManagedPublication,
  PublicationAttempt,
} from "@programmable-video/contracts";

export function latestPublicationAttempt(
  publication: ManagedPublication,
): PublicationAttempt {
  return publication.attempts.reduce((latest, attempt) =>
    attempt.attempt > latest.attempt ? attempt : latest,
  );
}
