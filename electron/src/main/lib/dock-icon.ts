export interface DockIconHost {
  platform: NodeJS.Platform;
  dock: { setIcon(iconPath: string): void } | undefined;
  exists(iconPath: string): boolean;
}

/**
 * macOS keeps showing a cached Dock tile after an in-place bundle update, so
 * the running app sets its tile from the icon shipped in the current bundle.
 */
export function applyDockIcon(host: DockIconHost, iconPath: string): boolean {
  if (host.platform !== 'darwin' || !host.dock) return false;
  if (!host.exists(iconPath)) return false;
  try {
    host.dock.setIcon(iconPath);
    return true;
  } catch {
    return false;
  }
}
