/* 16px stroke glyphs shared by context menus and row hover actions. */
const base = {
    viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
} as const;

export function PencilGlyph() {
    return <svg {...base}><path d="M10.8 2.7a1.6 1.6 0 0 1 2.3 2.3L5.6 12.5l-3 .8.8-3Z" /></svg>;
}
export function PinGlyph() {
    return <svg {...base}><path d="M9.7 2.3 13.7 6.3M10.6 3.2 6.9 6.1l-2.5-.3-1 1 5.8 5.8 1-1-.3-2.5 2.9-3.7M5.9 10.1 2.5 13.5" /></svg>;
}
export function ArchiveGlyph() {
    return <svg {...base}><rect x="2.3" y="3" width="11.4" height="3" rx="0.8" /><path d="M3.3 6v6.2a.8.8 0 0 0 .8.8h7.8a.8.8 0 0 0 .8-.8V6M6.5 8.8h3" /></svg>;
}
export function EyeGlyph() {
    return <svg {...base}><path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8Z" /><circle cx="8" cy="8" r="1.8" /></svg>;
}
export function TrashGlyph() {
    return <svg {...base}><path d="M2.8 4.3h10.4M6.3 4.3V3h3.4v1.3M4 4.3l.6 8.4a.8.8 0 0 0 .8.8h5.2a.8.8 0 0 0 .8-.8l.6-8.4" /></svg>;
}
export function CopyGlyph() {
    return <svg {...base}><rect x="5.3" y="5.3" width="8" height="8" rx="1.2" /><path d="M10.7 5.3V3.5a.8.8 0 0 0-.8-.8H3.5a.8.8 0 0 0-.8.8v6.4a.8.8 0 0 0 .8.8h1.8" /></svg>;
}
export function FolderGlyph() {
    return <svg {...base}><path d="M2.3 4.3a1 1 0 0 1 1-1h3l1.4 1.5h5a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3.3a1 1 0 0 1-1-1Z" /></svg>;
}
export function ExternalGlyph() {
    return <svg {...base}><path d="M6 3H3.5a.8.8 0 0 0-.8.8v8.7a.8.8 0 0 0 .8.8h8.7a.8.8 0 0 0 .8-.8V10M9 2.7h4.3V7M13.3 2.7 7.5 8.5" /></svg>;
}
export function PlayGlyph() {
    return <svg {...base}><path d="M4.5 3v10l8-5Z" /></svg>;
}
export function StopGlyph() {
    return <svg {...base}><rect x="3.5" y="3.5" width="9" height="9" rx="1.4" /></svg>;
}
export function RestartGlyph() {
    return <svg {...base}><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" /></svg>;
}
