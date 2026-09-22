/**
 * Keeps `ProjectToolServerRegistry` in step with settings.
 *
 * Seeds it once at startup and then follows `streamChanges`, so a tool server
 * added or re-pointed in settings reaches the next session a conversation
 * starts without the app being restarted.
 *
 * @module ProjectToolServerSync
 */
import type { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { setProjectToolServers } from "../ProjectToolServerRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const publish = (settings: ServerSettings): void => {
  setProjectToolServers(Object.values(settings.projectToolServers));
};

export const ProjectToolServerSyncLive: Layer.Layer<never, never, ServerSettingsService> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      // Seed before anything can start a session, so the first conversation of
      // a boot is not the one that misses its tools.
      const initial = yield* serverSettings.getSettings.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Project tool servers could not be read at startup", cause).pipe(
            Effect.as(null),
          ),
        ),
      );
      if (initial !== null) publish(initial);

      yield* serverSettings.streamChanges.pipe(
        Stream.runForEach((next) => Effect.sync(() => publish(next))),
        Effect.forkScoped,
      );
    }),
  );
