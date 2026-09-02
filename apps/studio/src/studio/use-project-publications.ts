import type { ManagedPublication } from "@programmable-video/contracts";
import { useEffect, useRef, useState } from "react";

import { loadPublications, retryPublication } from "../project-api";
import { latestPublicationAttempt } from "./latest-publication-attempt";

const pollIntervalMs = 3_000;

export interface ProjectPublicationOperations {
  loadPublications: typeof loadPublications;
  retryPublication: typeof retryPublication;
}

const defaultOperations: ProjectPublicationOperations = {
  loadPublications,
  retryPublication,
};

function isNewerOrEqual(
  incoming: ManagedPublication,
  current: ManagedPublication,
): boolean {
  const incomingAttempt = latestPublicationAttempt(incoming);
  const currentAttempt = latestPublicationAttempt(current);
  return (
    incomingAttempt.attempt > currentAttempt.attempt ||
    (incomingAttempt.attempt === currentAttempt.attempt &&
      incomingAttempt.updatedAt >= currentAttempt.updatedAt)
  );
}

function upsertPublication(
  publications: ManagedPublication[],
  publication: ManagedPublication,
): ManagedPublication[] {
  const current = publications.find((item) => item.id === publication.id);
  if (current && !isNewerOrEqual(publication, current)) return publications;

  return [
    publication,
    ...publications.filter((item) => item.id !== publication.id),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function mergePublications(
  current: ManagedPublication[],
  incoming: ManagedPublication[],
): ManagedPublication[] {
  return incoming.reduce(upsertPublication, current);
}

export interface ProjectPublications {
  publications: ManagedPublication[];
  loading: boolean;
  error: string | undefined;
  busyPublicationId: string | undefined;
  record: (publication: ManagedPublication) => void;
  retry: (publication: ManagedPublication) => Promise<void>;
}

export function useProjectPublications(
  projectId: string,
  operations: ProjectPublicationOperations = defaultOperations,
): ProjectPublications {
  const [publications, setPublications] = useState<ManagedPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busyPublicationId, setBusyPublicationId] = useState<string>();
  const pollRef = useRef<AbortController | undefined>(undefined);
  const mutationVersionRef = useRef(0);
  const projectIdRef = useRef(projectId);
  const loadProjectPublications = operations.loadPublications;
  projectIdRef.current = projectId;

  const beginMutation = () => {
    const mutationVersion = ++mutationVersionRef.current;
    pollRef.current?.abort();
    return mutationVersion;
  };

  const record = (publication: ManagedPublication) => {
    beginMutation();
    if (publication.projectId !== projectIdRef.current) return;
    setPublications((current) => upsertPublication(current, publication));
  };

  const retry = async (publication: ManagedPublication) => {
    const mutationVersion = beginMutation();
    const mutationProjectId = projectIdRef.current;
    setBusyPublicationId(publication.id);
    setError(undefined);
    try {
      const retried = await operations.retryPublication(
        mutationProjectId,
        publication.id,
      );
      if (
        mutationVersion !== mutationVersionRef.current ||
        mutationProjectId !== projectIdRef.current
      ) {
        return;
      }
      setPublications((current) => upsertPublication(current, retried));
    } catch (requestError) {
      if (
        mutationVersion === mutationVersionRef.current &&
        mutationProjectId === projectIdRef.current
      ) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Request failed",
        );
      }
    } finally {
      if (
        mutationVersion === mutationVersionRef.current &&
        mutationProjectId === projectIdRef.current
      ) {
        setBusyPublicationId(undefined);
      }
    }
  };

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    setPublications([]);
    setLoading(true);
    setError(undefined);
    setBusyPublicationId(undefined);

    const refresh = async (initial: boolean) => {
      controller = new AbortController();
      pollRef.current = controller;
      const mutationVersion = mutationVersionRef.current;
      try {
        const incoming = await loadProjectPublications(
          projectId,
          controller.signal,
        );
        if (!active || mutationVersion !== mutationVersionRef.current) return;
        setPublications((current) => mergePublications(current, incoming));
        setError(undefined);
      } catch (requestError) {
        if (active && !controller.signal.aborted) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Request failed",
          );
        }
      } finally {
        if (active) {
          if (initial) setLoading(false);
          timer = window.setTimeout(() => void refresh(false), pollIntervalMs);
        }
      }
    };

    void refresh(true);
    return () => {
      active = false;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadProjectPublications, projectId]);

  return {
    publications,
    loading,
    error,
    busyPublicationId,
    record,
    retry,
  };
}
