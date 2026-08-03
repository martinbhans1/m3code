import { createFileRoute } from "@tanstack/react-router";

import { DatabaseSettingsPanel } from "../components/settings/DatabaseSettings";

function SettingsDatabaseRoute() {
  return <DatabaseSettingsPanel />;
}

export const Route = createFileRoute("/settings/database")({
  component: SettingsDatabaseRoute,
});
