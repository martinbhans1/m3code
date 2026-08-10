import * as Schema from "effect/Schema";

import { PortSchema } from "./baseSchemas.ts";

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  t3Home: Schema.String,
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  /**
   * Dev builds share the installed app's `userdata` state store by default so a
   * hot-reloading dev window sees the same conversations, providers and
   * settings. Set when the desktop process opted into the isolated `dev`
   * sandbox instead, so the backend picks the same state dir the app did.
   */
  isolatedStateStore: Schema.optional(Schema.Boolean),
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;
