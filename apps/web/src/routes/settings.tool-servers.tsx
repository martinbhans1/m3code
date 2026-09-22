import { createFileRoute } from "@tanstack/react-router";

import { ProjectToolServersPanel } from "../components/settings/ProjectToolServersSettings";

function SettingsToolServersRoute() {
  return <ProjectToolServersPanel />;
}

export const Route = createFileRoute("/settings/tool-servers")({
  component: SettingsToolServersRoute,
});
