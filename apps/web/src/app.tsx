import { RouteLink, useRoute } from "./navigation.tsx";
import { ProjectListScreen } from "./project-list-screen.tsx";
import { ProjectScreen } from "./project-screen.tsx";
import { projectsRoute } from "./route.ts";

export function App() {
  const route = useRoute();

  switch (route.kind) {
    case "projects":
      return <ProjectListScreen />;
    case "project":
      return <ProjectScreen key={route.projectId} projectId={route.projectId} />;
    case "not_found":
      return (
        <p role="alert">
          このページはありません。 <RouteLink to={projectsRoute}>案件一覧へ</RouteLink>
        </p>
      );
  }
}
