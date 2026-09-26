import type { DashboardUiTheme } from '../types';
import { DesktopLink } from '../desktop-link';
import { CommandCenter } from './CommandCenter';
import { DesktopPanelControls } from './DesktopPanelControls';
import { ThemeSwitch } from './ThemeSwitch';

type CommandBarProps = {
    query: string;
    loading: boolean;
    theme: DashboardUiTheme;
    onQueryChange: (value: string) => void;
    onRefresh: () => void;
    onOpenDrawer: () => void;
    onThemeChange: (next: DashboardUiTheme) => void;
};

export function CommandBar(props: CommandBarProps) {
    return (
        <CommandCenter
            mobileMenuButton={(
                <button className="drawer-trigger command-icon-button" type="button" onClick={props.onOpenDrawer} aria-label="Open sidebar">
                    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false">
                        <path d="M4 6h12M4 10h12M4 14h12" />
                    </svg>
                </button>
            )}
            title={(
                <h1 className="manager-brand-heading" aria-label="CLI-JAW Dashboard">
                    <img className="manager-brand-mark" src="/icons/mascot.png" alt="" width={20} height={20} aria-hidden="true" />
                    <span className="manager-brand-wordmark">CLI-JAW</span>
                    <span className="manager-brand-dash">DASH</span>
                </h1>
            )}
            search={(
                <div className="search-input-wrapper is-ghost">
                    <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                    <input
                        value={props.query}
                        onChange={event => props.onQueryChange(event.target.value)}
                        placeholder="Search port, home, CLI, model"
                        aria-label="Search instances"
                    />
                </div>
            )}
            actions={(
                <div className="command-actions-group">
                    <DesktopPanelControls />
                    <DesktopLink />
                    <ThemeSwitch theme={props.theme} onChange={props.onThemeChange} />
                    <button
                        type="button"
                        className="command-icon-button"
                        onClick={props.onRefresh}
                        disabled={props.loading}
                        aria-label={props.loading ? 'Scanning' : 'Refresh'}
                        title={props.loading ? 'Scanning' : 'Refresh'}
                    >
                        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                            <path d="M16 10a6 6 0 1 1-2-4.5" />
                            <path d="M16 4v4h-4" />
                        </svg>
                    </button>
                </div>
            )}
        />
    );
}
