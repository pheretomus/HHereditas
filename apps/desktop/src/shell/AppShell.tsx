import type { CSSProperties, ReactNode } from 'react';
import { SplitPane, SplitView, TooltipProvider, cx, useControllableState, usePlatform, type Platform } from '@hhereditas/ui';
import { INSPECTOR_PANE_ID, SIDEBAR_PANE_ID } from './ids';
import styles from './AppShell.module.css';

export interface AppShellProps {
  /** Toolbar items, usually <ToolbarContent/>. Rendered in the title bar row. */
  toolbar?: ReactNode;
  /** Left pane, usually <Sidebar/>. Omit for a window without a sidebar. */
  sidebar?: ReactNode;
  /** Right pane, usually <Inspector/>. Omit for a window without an inspector. */
  inspector?: ReactNode;
  /** Bar under the main content, usually <StatusBar/>. */
  statusBar?: ReactNode;
  /** Main content, usually <MainArea/>. */
  children?: ReactNode;

  /** Sidebar shown (controlled). Dragging the divider closed reports false. */
  sidebarVisible?: boolean;
  defaultSidebarVisible?: boolean;
  onSidebarVisibleChange?: (visible: boolean) => void;
  /** Sidebar width in px (controlled). */
  sidebarWidth?: number;
  defaultSidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;

  inspectorVisible?: boolean;
  defaultInspectorVisible?: boolean;
  onInspectorVisibleChange?: (visible: boolean) => void;
  inspectorWidth?: number;
  defaultInspectorWidth?: number;
  onInspectorWidthChange?: (width: number) => void;

  /** False while the window is in the background: chrome dims like an inactive macOS window. */
  windowActive?: boolean;
  /** Platform chrome (default: detected). macOS reserves room for the traffic lights. */
  platform?: Platform;
  className?: string;
  style?: CSSProperties;
}

export const SIDEBAR_LIMITS = { min: 200, max: 380, default: 248 } as const;
export const INSPECTOR_LIMITS = { min: 240, max: 420, default: 288 } as const;
const CONTENT_MIN = 360;

/**
 * Document window layout (macOS 11+): a full-height sidebar on the left (the traffic lights
 * sit on its top), a unified toolbar over the content and the inspector, the canvas in the
 * middle with a slim status bar, and the inspector on the right. Both side panes resize by
 * dragging their hairline divider and collapse (drag closed, double-click the divider, or the
 * toolbar toggles). Empty title-bar areas are Tauri drag regions. While the window is
 * inactive (`windowActive={false}`) the chrome dims and accent colours turn graphite.
 */
export function AppShell({
  toolbar,
  sidebar,
  inspector,
  statusBar,
  children,
  sidebarVisible,
  defaultSidebarVisible = true,
  onSidebarVisibleChange,
  sidebarWidth,
  defaultSidebarWidth = SIDEBAR_LIMITS.default,
  onSidebarWidthChange,
  inspectorVisible,
  defaultInspectorVisible = true,
  onInspectorVisibleChange,
  inspectorWidth,
  defaultInspectorWidth = INSPECTOR_LIMITS.default,
  onInspectorWidthChange,
  windowActive = true,
  platform: platformProp,
  className,
  style,
}: AppShellProps) {
  const detected = usePlatform();
  const platform = platformProp ?? detected;
  const [showSidebar, setShowSidebar] = useControllableState(sidebarVisible, defaultSidebarVisible, onSidebarVisibleChange);
  const [showInspector, setShowInspector] = useControllableState(inspectorVisible, defaultInspectorVisible, onInspectorVisibleChange);
  const [sidebarPx, setSidebarPx] = useControllableState(sidebarWidth, defaultSidebarWidth, onSidebarWidthChange);
  const [inspectorPx, setInspectorPx] = useControllableState(inspectorWidth, defaultInspectorWidth, onInspectorWidthChange);
  const sidebarShown = !!sidebar && showSidebar;

  const main = (
    <div className={styles.mainColumn}>
      <div
        className={styles.titlebar}
        // "deep": empty toolbar space drags the window, controls keep their clicks.
        data-tauri-drag-region="deep"
        data-inset={sidebarShown ? undefined : ''}
        role="presentation"
      >
        {toolbar}
      </div>
      <div className={styles.body}>
        <SplitView>
          <SplitPane id="content" minSize={CONTENT_MIN}>
            <div className={styles.contentColumn}>
              <main className={styles.content}>{children}</main>
              {statusBar}
            </div>
          </SplitPane>
          {inspector ? (
            <SplitPane
              id="inspector"
              label="Inspector"
              size={inspectorPx}
              onSizeChange={setInspectorPx}
              minSize={INSPECTOR_LIMITS.min}
              maxSize={INSPECTOR_LIMITS.max}
              collapsible
              collapsed={!showInspector}
              onCollapsedChange={(c) => setShowInspector(!c)}
            >
              <aside id={INSPECTOR_PANE_ID} className={styles.inspector} aria-label="Inspector">
                {inspector}
              </aside>
            </SplitPane>
          ) : null}
        </SplitView>
      </div>
    </div>
  );

  return (
    <TooltipProvider>
      <div
        className={cx(styles.window, className)}
        style={style}
        data-platform={platform}
        data-inactive={windowActive ? undefined : ''}
      >
        {sidebar ? (
          <SplitView>
            <SplitPane
              id="sidebar"
              label="Sidebar"
              size={sidebarPx}
              onSizeChange={setSidebarPx}
              minSize={SIDEBAR_LIMITS.min}
              maxSize={SIDEBAR_LIMITS.max}
              collapsible
              collapsed={!showSidebar}
              onCollapsedChange={(c) => setShowSidebar(!c)}
            >
              <nav id={SIDEBAR_PANE_ID} className={styles.sidebar} aria-label="Sidebar">
                {/* The traffic lights sit here on macOS; the strip drags the window. */}
                <div className={styles.sidebarTitlebar} data-tauri-drag-region="deep" />
                <div className={styles.sidebarBody}>{sidebar}</div>
              </nav>
            </SplitPane>
            {/* The main column must keep room for the content AND the inspector's minimum. */}
            <SplitPane id="main" minSize={CONTENT_MIN + (inspector && showInspector ? INSPECTOR_LIMITS.min : 0)}>
              {main}
            </SplitPane>
          </SplitView>
        ) : (
          main
        )}
      </div>
    </TooltipProvider>
  );
}
