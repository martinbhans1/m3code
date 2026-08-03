import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import { type DiffRouteSearch, parseDiffRouteSearch } from "../diffRouteSearch";
import { selectEnvironmentState, selectThreadExistsByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteRef } from "../threadRoutes";
import { SidebarInset } from "~/components/ui/sidebar";
import { NoActiveThreadState } from "../components/NoActiveThreadState";

function ChatThreadRouteView() {
  const navigate = useNavigate();
  // Select the raw params, not the resolved ref: `resolveThreadRouteRef` builds a
  // fresh object every call, and the router only de-dupes a `select` result when
  // structural sharing is on (it isn't). A new `threadRef` identity per render
  // re-fires the effects below — including the `navigate` one — on every render.
  const environmentIdParam = Route.useParams({ select: (params) => params.environmentId });
  const threadIdParam = Route.useParams({ select: (params) => params.threadId });
  const threadRef = useMemo(
    () => resolveThreadRouteRef({ environmentId: environmentIdParam, threadId: threadIdParam }),
    [environmentIdParam, threadIdParam],
  );
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).bootstrapComplete,
  );
  const serverThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const threadExists = useStore((store) => selectThreadExistsByRef(store, threadRef));
  const environmentHasServerThreads = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).threadIds.length > 0,
  );
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!threadRef) return false;
    return store.hasDraftThreadsInEnvironment(threadRef.environmentId);
  });
  const routeThreadExists = threadExists || draftThreadExists;
  const serverThreadStarted = threadHasStarted(serverThread);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) return;
    if (!routeThreadExists && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, routeThreadExists, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread?.promotedTo) return;
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread?.promotedTo, serverThreadStarted, threadRef]);

  // Never render a bare `null` here: on mobile that is a blank screen with no
  // sidebar toggle and no back affordance, and the redirect above only fires
  // when the environment has other threads to fall back to.
  if (!threadRef) {
    return (
      <NoActiveThreadState
        headerLabel="Thread not found"
        title="This thread isn't available"
        description="The link points at a thread that no longer exists. Pick another one from the list."
      />
    );
  }
  // Transient states get neutral copy: the redirect above is an effect, so it
  // lands a frame or two late, and flashing "this thread is gone" at someone
  // who just deleted a thread (or is simply still connecting) reads as an error
  // when nothing is wrong.
  if (!bootstrapComplete || (!routeThreadExists && environmentHasAnyThreads)) {
    return <NoActiveThreadState headerLabel="Loading" title="Loading thread…" description="" />;
  }
  if (!routeThreadExists) {
    return (
      <NoActiveThreadState
        headerLabel="Thread not found"
        title="This thread isn't available"
        description="It may have been deleted, or it lives in another environment."
      />
    );
  }

  return (
    <SidebarInset className="app-chat-surface h-svh min-h-0 overflow-hidden overscroll-y-none bg-transparent text-foreground md:h-dvh">
      <ChatView
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        routeKind="server"
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [retainSearchParams<DiffRouteSearch>(["diff"])],
  },
  component: ChatThreadRouteView,
});
