import * as Effect from "effect/Effect";

import { FollowupToolkit } from "./tools.ts";

// The real work (surfacing the follow-up as a runtime event) happens in the
// provider adapter's permission callback when it observes this tool call. The
// handler only has to acknowledge so the agent sees a successful result and
// continues without interruption.
const handlers = {
  suggest_followup: () => Effect.succeed({ acknowledged: true }),
} satisfies Parameters<typeof FollowupToolkit.toLayer>[0];

export const FollowupToolkitHandlersLive = FollowupToolkit.toLayer(handlers);
