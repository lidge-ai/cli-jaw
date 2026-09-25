import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCodeController } from './useCodeController';
import { CodeSessionList } from './CodeSessionList';
import { CodeWorkbench } from './CodeWorkbench';

type CodeCanvasProps = {
    port: number;
    workingDir: string;
    onWorkingDirChange?: (path: string | null) => void;
    onOpenLocalFile?: (path: string) => void;
    /** Resolved `newCodeSession` chord, shown as the button's shortcut hint. */
    newSessionShortcut?: string | undefined;
};

export function CodeCanvas({ port, workingDir, onWorkingDirChange, onOpenLocalFile, newSessionShortcut }: CodeCanvasProps) {
    const controller = useCodeController({ port, workingDir });
    const [sidebarHost, setSidebarHost] = useState<HTMLElement | null>(null);
    const previousWorkspace = useRef({ port, id: controller.selectedId, cwd: controller.selection.cwd });
    useEffect(() => {
        setSidebarHost(document.getElementById('code-session-sidebar-host'));
    }, []);
    useEffect(() => {
        const previous = previousWorkspace.current;
        const next = { port, id: controller.selectedId, cwd: controller.selection.cwd };
        previousWorkspace.current = next;
        if (previous.port === port && previous.id === null && next.id === null && previous.cwd !== next.cwd) {
            onWorkingDirChange?.(next.cwd || null);
        }
    }, [port, controller.selectedId, controller.selection.cwd, onWorkingDirChange]);
    const navigator = <CodeSessionList key={port} controller={controller} newSessionShortcut={newSessionShortcut} />;
    const workbench = <CodeWorkbench key={port} controller={controller} endpointKey={String(port)} onOpenLocalFile={onOpenLocalFile} />;
    if (sidebarHost) return <>
        {createPortal(<div className="code-manager-session-navigator-content">{navigator}</div>, sidebarHost)}
        <div className="code-canvas code-canvas-workbench">{workbench}</div>
    </>;
    return <div className="code-canvas">
        <div className="code-canvas-sidebar">{navigator}</div>
        {workbench}
    </div>;
}
