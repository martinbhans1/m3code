import { createFileRoute } from "@tanstack/react-router";

import { UsageReportPanel } from "../components/settings/UsageReportPanel";

export const Route = createFileRoute("/settings/usage")({
  component: UsageReportPanel,
});
