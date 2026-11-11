import { Stack, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Text as RNText, View } from "react-native";

import { buildThreadRoutePath } from "../lib/routes";
import { scopedProjectKey } from "../lib/scopedEntities";
import { useRemoteCatalog } from "../state/use-remote-catalog";
import { useRemoteEnvironmentState } from "../state/use-remote-environment-registry";
import { HomeScreen } from "../features/home/HomeScreen";
import { useThemeColor } from "../lib/useThemeColor";

/* ─── Route screen ───────────────────────────────────────────────────── */

export default function HomeRouteScreen() {
  const {
    projects,
    serverConfigByEnvironmentId,
    state: catalogState,
    threads,
  } = useRemoteCatalog();
  const orchestratorProjectKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const project of projects) {
      const config = serverConfigByEnvironmentId[project.environmentId];
      if (config?.settings.orchestratorProjectId === project.id) {
        keys.add(scopedProjectKey(project.environmentId, project.id));
      }
    }
    return keys;
  }, [projects, serverConfigByEnvironmentId]);
  const { savedConnectionsById } = useRemoteEnvironmentState();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [hideCompleted, setHideCompleted] = useState(true);
  const [selectedTagsByProject, setSelectedTagsByProject] = useState<
    Readonly<Record<string, ReadonlyArray<string>>>
  >({});
  const taggedProjects = useMemo(
    () =>
      projects
        .filter((project) => project.threadTags.length > 0)
        .map((project) => ({
          key: scopedProjectKey(project.environmentId, project.id),
          title: project.title,
          tags: project.threadTags,
        })),
    [projects],
  );
  const hasTagSelection = Object.values(selectedTagsByProject).some((tags) => tags.length > 0);
  const toggleTag = (projectKey: string, tag: string) =>
    setSelectedTagsByProject((current) => {
      const selected = current[projectKey] ?? [];
      return {
        ...current,
        [projectKey]: selected.includes(tag)
          ? selected.filter((entry) => entry !== tag)
          : [...selected, tag],
      };
    });

  const iconColor = useThemeColor("--color-icon");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const subtleColor = useThemeColor("--color-subtle");

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          headerTransparent: true,
          headerStyle: { backgroundColor: "transparent" },
          headerShadowVisible: false,
          headerTintColor: iconColor,
          headerTitle: "",
          headerSearchBarOptions: {
            placeholder: "Search threads and messages",
            onChangeText: (event) => {
              setSearchQuery(event.nativeEvent.text);
            },
            allowToolbarIntegration: true,
          },
        }}
      />

      {/* Header left: plain text, no Liquid Glass button chrome */}
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.View hidesSharedBackground>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <RNText
              style={{
                fontFamily: "DMSans_700Bold",
                fontSize: 17,
                color: iconColor,
                letterSpacing: -0.4,
              }}
            >
              M3 Code
            </RNText>
            <View
              style={{
                backgroundColor: subtleColor,
                borderRadius: 99,
                paddingHorizontal: 8,
                paddingVertical: 3,
              }}
            >
              <RNText
                style={{
                  fontFamily: "DMSans_700Bold",
                  fontSize: 10,
                  color: mutedColor,
                  letterSpacing: 1.1,
                  textTransform: "uppercase",
                }}
              >
                Alpha
              </RNText>
            </View>
          </View>
        </Stack.Toolbar.View>
      </Stack.Toolbar>

      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          icon={
            hasTagSelection
              ? "line.3.horizontal.decrease.circle.fill"
              : "line.3.horizontal.decrease.circle"
          }
          title="Filter conversations"
          separateBackground
        >
          <Stack.Toolbar.MenuAction
            isOn={hideCompleted}
            onPress={() => setHideCompleted((current) => !current)}
            unstable_keepPresented
          >
            <Stack.Toolbar.Label>Hide completed</Stack.Toolbar.Label>
          </Stack.Toolbar.MenuAction>
          {taggedProjects.map((project) => (
            <Stack.Toolbar.Menu
              key={project.key}
              inline
              title={taggedProjects.length > 1 ? `Tags · ${project.title}` : "Tags"}
            >
              {project.tags.map((tag) => (
                <Stack.Toolbar.MenuAction
                  key={tag.name}
                  isOn={(selectedTagsByProject[project.key] ?? []).includes(tag.name)}
                  onPress={() => toggleTag(project.key, tag.name)}
                  subtitle={tag.description || undefined}
                  unstable_keepPresented
                >
                  <Stack.Toolbar.Label>{tag.name}</Stack.Toolbar.Label>
                </Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>
          ))}
          {hasTagSelection ? (
            <Stack.Toolbar.MenuAction onPress={() => setSelectedTagsByProject({})}>
              <Stack.Toolbar.Label>Clear tag filters</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
          ) : null}
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Button
          icon="gearshape"
          onPress={() => router.push("/settings")}
          separateBackground
        />
      </Stack.Toolbar>

      {/* Bottom toolbar: search + compose, visually split like iMessage */}
      <Stack.Toolbar placement="bottom">
        <Stack.Toolbar.SearchBarSlot />
        <Stack.Toolbar.Spacer width={8} sharesBackground={false} />
        <Stack.Toolbar.Button
          icon="square.and.pencil"
          onPress={() => router.push("/new")}
          separateBackground
        />
      </Stack.Toolbar>

      <HomeScreen
        projects={projects}
        threads={threads}
        catalogState={catalogState}
        savedConnectionsById={savedConnectionsById}
        searchQuery={searchQuery}
        hideCompleted={hideCompleted}
        selectedTagsByProject={selectedTagsByProject}
        orchestratorProjectKeys={orchestratorProjectKeys}
        onAddConnection={() => router.push("/connections/new")}
        onSelectThread={(thread) => {
          router.push(buildThreadRoutePath(thread));
        }}
        onSelectSearchResult={(result) => {
          router.push(buildThreadRoutePath(result));
        }}
      />
    </>
  );
}
