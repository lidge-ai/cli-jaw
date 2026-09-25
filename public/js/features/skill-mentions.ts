// ── Inline `$skill` mentions ──
// Typing `$` anywhere in the composer lists the active skills; picking one
// inserts `$<id> ` at the caret. The server expands the mention when the
// message runs (src/core/skill-mentions.ts); the chat keeps the typed text.
import { state } from '../state.js';
import { fetchWithLocale } from './i18n.js';
import { escapeHtml } from '../render.js';
import { isDropdownOpen as isSlashDropdownOpen } from './slash-commands.js';
import { findSkillMentionToken, rankSkillMentions, type SkillMentionToken } from '../../../src/shared/skill-mention.js';

interface MentionSkill { id: string; name?: string | undefined; description?: string | undefined; enabled?: boolean | undefined }

let filtered: MentionSkill[] = [];
let selectedIdx = 0;
let isOpen = false;
let token: SkillMentionToken | null = null;
let loading: Promise<void> | null = null;
/** Bumped by every update() and close(): an older async update never renders. */
let updateSeq = 0;

const dropdown = (): HTMLElement | null => document.getElementById('skillMentionDropdown');
const input = (): HTMLTextAreaElement | null => document.getElementById('chatInput') as HTMLTextAreaElement | null;

function activeSkills(): MentionSkill[] {
    return (state.allSkills as MentionSkill[]).filter(skill => skill && skill.enabled && typeof skill.id === 'string');
}

/** The skills panel owns `state.allSkills`; load it once if that panel never opened. */
function ensureSkillsLoaded(): Promise<void> {
    if ((state.allSkills as unknown[]).length) return Promise.resolve();
    loading ??= fetchWithLocale('/api/skills')
        .then(res => res.json())
        .then((list: unknown) => {
            if (Array.isArray(list) && !(state.allSkills as unknown[]).length) state.allSkills = list;
        })
        .catch(() => { /* popup stays closed; sending does not depend on it */ })
        .finally(() => { loading = null; });
    return loading;
}

/** The `/` list fades for 150ms after it closes; clear it so the two never stack. */
function hideFadingSlashList(): void {
    const slash = document.getElementById('cmdDropdown');
    if (!slash) return;
    slash.classList.remove('visible');
    slash.style.display = 'none';
}

function render(): void {
    const el = dropdown();
    const inp = input();
    if (!el || !inp) return;
    hideFadingSlashList();
    el.innerHTML = filtered.map((skill, i) => `<div class="cmd-item${i === selectedIdx ? ' selected' : ''}"
            role="option" id="skill-mention-item-${i}" aria-selected="${i === selectedIdx}" data-index="${i}">
            <span class="cmd-name">$${escapeHtml(skill.id)}</span>
            <span class="cmd-desc">${escapeHtml(skill.description || skill.name || '')}</span>
        </div>`).join('');
    el.style.display = 'block';
    requestAnimationFrame(() => el.classList.add('visible'));
    isOpen = true;
    inp.setAttribute('aria-controls', 'skillMentionDropdown');
    inp.setAttribute('aria-expanded', 'true');
    inp.setAttribute('aria-activedescendant', `skill-mention-item-${selectedIdx}`);
    el.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
}

export function close(): void {
    updateSeq++; // also cancels an update() still awaiting the skill list
    if (!isOpen) return;
    isOpen = false; filtered = []; selectedIdx = 0; token = null;
    const el = dropdown();
    if (el) { el.classList.remove('visible'); el.style.display = 'none'; el.innerHTML = ''; }
    const inp = input();
    if (!inp) return;
    // The textarea points back at the `/` list either way; if that list just
    // opened on the same frame it owns expanded/activedescendant, so leave those.
    inp.setAttribute('aria-controls', 'cmdDropdown');
    if (!isSlashDropdownOpen()) {
        inp.setAttribute('aria-expanded', 'false');
        inp.setAttribute('aria-activedescendant', '');
    }
}

export async function update(inp: HTMLTextAreaElement | null): Promise<void> {
    const seq = ++updateSeq;
    if (!inp || isSlashDropdownOpen() || inp.selectionStart !== inp.selectionEnd) { close(); return; }
    if (!findSkillMentionToken(inp.value, inp.selectionStart ?? inp.value.length)) { close(); return; }
    await ensureSkillsLoaded();
    if (seq !== updateSeq) return; // a newer keystroke, a close() or a send owns the popup now
    // Re-read after the await: the text or caret may have moved while the list loaded.
    const next = findSkillMentionToken(inp.value, inp.selectionStart ?? inp.value.length);
    if (!next || isSlashDropdownOpen()) { close(); return; }
    const ranked = rankSkillMentions(activeSkills(), next.query);
    if (!ranked.length) { close(); return; }
    token = next; filtered = ranked; selectedIdx = 0;
    render();
}

function applySelection(): void {
    const skill = filtered[selectedIdx];
    const inp = input();
    const at = token;
    close();
    if (!skill || !inp || !at) return;
    const caret = inp.selectionStart ?? inp.value.length;
    const inserted = `$${skill.id} `;
    inp.value = inp.value.slice(0, at.start) + inserted + inp.value.slice(caret);
    const pos = at.start + inserted.length;
    inp.focus();
    inp.selectionStart = inp.selectionEnd = pos;
    inp.dispatchEvent(new Event('input', { bubbles: true })); // auto-resize + draft listeners
}

export function handleKeydown(e: KeyboardEvent): boolean {
    if (!isOpen) return false;
    if (e.isComposing) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(filtered.length - 1, selectedIdx + 1); render(); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = Math.max(0, selectedIdx - 1); render(); return true; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); applySelection(); return true; }
    if (e.key === 'Escape') { e.preventDefault(); close(); return true; }
    return false; // caret keys fall through; the keyup listener re-evaluates the token
}

export function handleClick(e: Event): void {
    const item = (e.target as HTMLElement).closest('.cmd-item') as HTMLElement | null;
    if (!item) return;
    const idx = Number.parseInt(item.dataset['index'] || '-1', 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= filtered.length) return;
    selectedIdx = idx;
    applySelection();
}

export function handleOutsideClick(e: Event): void {
    if (!isOpen) return;
    const el = dropdown();
    // Same test as the `/` list: clicks in the textarea are caret moves, re-evaluated by update().
    if (el && !el.contains(e.target as Node) && e.target !== input()) close();
}
