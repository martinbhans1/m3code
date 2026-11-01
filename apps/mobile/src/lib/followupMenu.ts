import type { MenuAction } from "@react-native-menu/menu";
import type { ProjectId } from "@t3tools/contracts";

export type FollowupMenuChoice =
  | { readonly kind: "start"; readonly projectId: ProjectId | null }
  | { readonly kind: "here" }
  | { readonly kind: "dismiss" };

export interface FollowupProjectChoice {
  readonly id: ProjectId;
  readonly title: string;
}

const START_ID = "start";
const START_IN_PROJECT_PREFIX = "start-in:";
const HERE_ID = "here";
const DISMISS_ID = "dismiss";

/**
 * Every action a suggested task offers, behind the one button on its row.
 *
 * `projectChoices` is only populated in the orchestrator: its project is a
 * bookkeeping workspace with no code in it, so starting "here" would just open
 * a second orchestrator conversation. The work has to name a real project.
 */
export function buildFollowupMenuActions(input: {
  readonly projectChoices: ReadonlyArray<FollowupProjectChoice>;
  readonly threadBusy: boolean;
}): MenuAction[] {
  const start: MenuAction =
    input.projectChoices.length > 0
      ? {
          id: START_ID,
          title: "Start in…",
          image: "plus.bubble",
          subactions: input.projectChoices.map((project) => ({
            id: `${START_IN_PROJECT_PREFIX}${project.id}`,
            title: project.title,
          })),
        }
      : { id: START_ID, title: "Start in new conversation", image: "plus.bubble" };

  return [
    start,
    {
      id: HERE_ID,
      // A running conversation has no room for this until its turn ends.
      title: input.threadBusy ? "Do here (conversation is busy)" : "Do in this conversation",
      image: "arrow.turn.down.left",
      attributes: { disabled: input.threadBusy },
    },
    {
      id: DISMISS_ID,
      title: "Dismiss",
      image: "xmark",
      attributes: { destructive: true },
    },
  ];
}

export function parseFollowupMenuEvent(event: string): FollowupMenuChoice | null {
  if (event === START_ID) return { kind: "start", projectId: null };
  if (event === HERE_ID) return { kind: "here" };
  if (event === DISMISS_ID) return { kind: "dismiss" };
  if (event.startsWith(START_IN_PROJECT_PREFIX)) {
    return {
      kind: "start",
      projectId: event.slice(START_IN_PROJECT_PREFIX.length) as ProjectId,
    };
  }
  return null;
}
