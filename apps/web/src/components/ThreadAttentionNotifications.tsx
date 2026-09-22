import { useEffect, useMemo, useRef } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";

import { useSettings } from "../hooks/useSettings";
import {
  focusAppWindow,
  requestSystemNotificationPermission,
  showSystemNotification,
} from "../lib/systemNotifications";
import {
  selectProjectByRef,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
  type AppState,
} from "../store";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import {
  evaluateThreadAttentionNotifications,
  type ThreadAttentionCandidate,
  type ThreadAttentionPreferences,
} from "./ThreadAttentionNotifications.logic";

/**
 * Store changes arrive far faster than a person can read a toast — a single
 * turn produces a stream of them. Collapsing a burst into one evaluation keeps
 * this off the hot path; a quarter second of latency on a notification about
 * work that just finished is not noticeable.
 */
const EVALUATION_COALESCE_MS = 250;

function collectThreadAttentionCandidates(state: AppState): ThreadAttentionCandidate[] {
  return selectSidebarThreadsAcrossEnvironments(state).map((thread) => {
    const project = selectProjectByRef(
      state,
      scopeProjectRef(thread.environmentId, thread.projectId),
    );
    return {
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      environmentId: thread.environmentId,
      threadId: thread.id,
      threadTitle: thread.title,
      projectTitle: project?.name ?? "Unknown project",
      archivedAt: thread.archivedAt,
      thread: {
        hasActionableProposedPlan: thread.hasActionableProposedPlan,
        hasPendingApprovals: thread.hasPendingApprovals,
        hasPendingUserInput: thread.hasPendingUserInput,
        interactionMode: thread.interactionMode,
        latestTurn: thread.latestTurn,
        session: thread.session,
        updatedAt: thread.updatedAt,
        // Deliberately no `lastVisitedAt`: this coordinator tracks what it has
        // already announced itself, and a thread visited before its latest turn
        // finished is still news.
      },
    };
  });
}

/**
 * Raises OS notifications for threads that are waiting on the user — finished,
 * failed, or blocked on an answer — so a conversation left in the background
 * is not missed.
 */
export function ThreadAttentionNotifications() {
  const navigate = useNavigate();
  const enabled = useSettings((settings) => settings.systemNotificationsEnabled);
  const turnCompleted = useSettings((settings) => settings.systemNotifyOnTurnCompleted);
  const inputNeeded = useSettings((settings) => settings.systemNotifyOnInputNeeded);
  const failure = useSettings((settings) => settings.systemNotifyOnFailure);
  const suppressWhenFocused = useSettings(
    (settings) => settings.systemNotificationsSuppressWhenFocused,
  );
  const activeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });

  const preferences = useMemo<ThreadAttentionPreferences>(
    () => ({ enabled, turnCompleted, inputNeeded, failure, suppressWhenFocused }),
    [enabled, failure, inputNeeded, suppressWhenFocused, turnCompleted],
  );

  // Read at evaluation time rather than resubscribing: the subscription must
  // outlive every preference and route change, or the signatures it has
  // recorded are lost and the next store update re-announces everything.
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const activeThreadKeyRef = useRef<string | null>(null);
  activeThreadKeyRef.current = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const signaturesRef = useRef<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    if (!enabled) return;
    void requestSystemNotificationPermission();
  }, [enabled]);

  useEffect(() => {
    let pendingEvaluation: ReturnType<typeof setTimeout> | null = null;

    const evaluate = () => {
      const evaluation = evaluateThreadAttentionNotifications({
        candidates: collectThreadAttentionCandidates(useStore.getState()),
        previous: signaturesRef.current,
        preferences: preferencesRef.current,
        activeThreadKey: activeThreadKeyRef.current,
        windowFocused: typeof document === "undefined" ? false : document.hasFocus(),
        now: Date.now(),
      });
      signaturesRef.current = evaluation.state;

      for (const notification of evaluation.notifications) {
        showSystemNotification({
          tag: notification.key,
          title: notification.title,
          body: notification.body,
          onActivate: () => {
            focusAppWindow();
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(notification.environmentId, notification.threadId),
              ),
            });
          },
        });
      }
    };

    // Seeds the signatures for everything already loaded, so the first store
    // change is judged against the current state rather than an empty one.
    evaluate();

    const unsubscribe = useStore.subscribe(() => {
      if (pendingEvaluation !== null) return;
      pendingEvaluation = setTimeout(() => {
        pendingEvaluation = null;
        evaluate();
      }, EVALUATION_COALESCE_MS);
    });

    return () => {
      unsubscribe();
      if (pendingEvaluation !== null) {
        clearTimeout(pendingEvaluation);
      }
    };
  }, [navigate]);

  return null;
}
