import init, * as module from "../../../../crates/viewer/pkg/madori_viewer.js";
let loading: Promise<typeof module> | undefined;
export function loadViewerModule(): Promise<typeof module> {
  loading ??= init()
    .then(() => module)
    .catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  return loading;
}

export {
  Viewer,
  ViewerFailure,
  ViewerErrorCode,
} from "../../../../crates/viewer/pkg/madori_viewer.js";
