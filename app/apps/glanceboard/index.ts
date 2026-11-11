import { type AppDefinition } from "../app-definition";
import { GlanceBoard } from "./board";
import {
  createGlanceboardAppWindow,
  createPinnedGlanceboardWindow,
  GLANCEBOARD_SURFACE_ID,
  GLANCEBOARD_WINDOW_ID,
  PINNED_GLANCEBOARD_SURFACE_ID,
  PINNED_GLANCEBOARD_WINDOW_ID,
} from "./glanceboard-app";
import {
  glanceboardEnabledSetting,
  glanceDepth,
  glanceLayout,
  glanceShowOnHeadTiltSetting,
  glanceShowOnLongPressSetting,
  glanceShowOnTap,
  glanceTapTimeoutMs,
} from "./glanceboard-settings";

const glanceboardApp: AppDefinition = {
  appId: "glanceboard",
  title: "Glanceboard",
  icon: "eye",
  // Launcher is booted first. Registering this live board now makes it the
  // second permanent switcher entry; the settings app launched below remains
  // a separate, closeable window.
  boot: (ctx) => {
    ctx.openInProcessAppInBackground?.(
      PINNED_GLANCEBOARD_WINDOW_ID,
      PINNED_GLANCEBOARD_SURFACE_ID,
      createPinnedGlanceboardWindow,
    );
  },
  launch: (ctx) => ctx.launchInProcessApp(GLANCEBOARD_WINDOW_ID, GLANCEBOARD_SURFACE_ID, createGlanceboardAppWindow),
  glanceboard: {
    get size() {
      const layout = glanceLayout();
      return { width: layout.width, height: layout.height };
    },
    isEnabled: () => glanceboardEnabledSetting.get(),
    showOnTap: glanceShowOnTap,
    tapTimeoutMs: glanceTapTimeoutMs,
    showOnLongPress: () => glanceShowOnLongPressSetting.get(),
    showOnHeadTilt: () => glanceShowOnHeadTiltSetting.get(),
    depth: glanceDepth,
    createBoard: (requestRender) => new GlanceBoard(requestRender),
  },
};

export default glanceboardApp;
