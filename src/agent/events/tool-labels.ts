// Tool label extraction for CLI events

import { stripUndefined } from '../../core/strip-undefined.js';
import { displayShellCommand, displayShellCommandDetail } from '../../shared/shell-command-display.js';
import type { SpawnContext, ToolEntry, CliEventRecord } from './types.js';
import {
    asCliEventRecord,
    fieldNumber,
    fieldString,
} from '../../types/cli-events.js';
import { isClaudeLikeCli } from '../cli-helpers.js';
import {
    buildPreview,
    clipText,
    appendDetail,
    formatJsonDetail,
    buildClaudeThinkingTool,
    summarizeToolInput,
    isOpencodeToolFailure,
    extractText,
    formatOpenCodeTaskDetail,
} from './helpers.js';

export { summarizeToolInput };

function makeClaudeToolKey(event: CliEventRecord, label: ToolEntry) {
    // Prefer the unique tool_use id (carried in stepRef) so multi-turn streams with
    // matching tool names across distinct messages don't collide on the per-message index.
    if (label.stepRef) return `claude:ref:${label.stepRef}:${label.icon}:${label.label}`;
    const msgId = event.message?.id || '';
    const idx = event.event?.["index"];
    if (msgId && idx !== undefined && idx !== null) return `claude:msg:${msgId}:${idx}:${label.icon}:${label.label}`;
    if (idx !== undefined && idx !== null) return `claude:idx:${idx}:${label.icon}:${label.label}`;
    if (msgId) return `claude:msg:${msgId}:${label.icon}:${label.label}`;
    return `claude:type:${event.type}:${label.icon}:${label.label}`;
}

function pushToolLabel(labels: ToolEntry[], label: ToolEntry, cli: string, event: CliEventRecord, ctx: SpawnContext | null) {
    if (!isClaudeLikeCli(cli) || !ctx?.seenToolKeys) {
        labels.push(label);
        return;
    }
    const key = makeClaudeToolKey(event, label);
    if (ctx.seenToolKeys.has(key)) return;
    ctx.seenToolKeys.add(key);
    labels.push(label);
}

// Returns array of tool labels (supports multiple blocks per event)
export function extractToolLabels(cli: string, event: CliEventRecord, ctx: SpawnContext | null = null): ToolEntry[] {
    const item = event.item || event.part || event;
    const labels: ToolEntry[] = [];

    if (cli === 'codex' && (event.type === 'item.started' || event.type === 'item.completed') && item) {
        if (event.type === 'item.completed' && item.type === 'web_search') {
            const action = item.action?.type || '';
            const stepRef = item.id ? `codex:item:${item.id}` : undefined;
            if (action === 'search') {
                const query = item.query || item.action?.query || 'search';
                labels.push({ icon: '🔍', label: buildPreview(query, 60), toolType: 'search', detail: query,
                    ...(stepRef ? { stepRef } : {}), status: 'done' });
            } else if (action === 'open_page') {
                const url = item.action?.url || '';
                try {
                    labels.push({ icon: '🌐', label: new URL(url).hostname, toolType: 'search', detail: url,
                        ...(stepRef ? { stepRef } : {}), status: 'done' });
                } catch {
                    labels.push({ icon: '🌐', label: 'page', toolType: 'search', detail: url,
                        ...(stepRef ? { stepRef } : {}), status: 'done' });
                }
            } else {
                const query = item.query || 'web';
                labels.push({ icon: '🔍', label: buildPreview(query, 60), toolType: 'search', detail: query,
                    ...(stepRef ? { stepRef } : {}), status: 'done' });
            }
        }
        if (event.type === 'item.completed' && item.type === 'reasoning') {
            const detail = String(item.text || '').replace(/\*+/g, '').trim();
            labels.push({ icon: '💭', label: buildPreview(detail, 60) || 'thinking...', toolType: 'thinking', detail });
        }
        if (event.type === 'item.completed' && item.type === 'command_execution') {
            const rawCommand = String(item.command || 'exec');
            const command = displayShellCommand(rawCommand);
            const output = item.aggregated_output ? String(item.aggregated_output) : '';
            const detail = displayShellCommandDetail(output ? `$ ${rawCommand}\n${output}` : rawCommand);
            // [P0-1.4] Use item.id for unique stepRef (not command string)
            const ref = `codex:item:${item.id || rawCommand}`;
            // [P1-2.4] Include exit_code in label status
            const exitCode = item.exit_code;
            const failed = exitCode != null && exitCode !== 0;
            labels.push({
                icon: failed ? '❌' : '⚡',
                label: buildPreview(command, 40) || 'exec',
                toolType: 'tool',
                detail,
                stepRef: ref,
                status: failed ? 'error' : 'done',
                ...(exitCode != null ? { exitCode } : {}),
            });
        }
        if (item.type === 'collab_tool_call') {
            const tool = String(item.tool || item.name || 'subagent');
            const ref = `codex:collab:${item.id || tool}`;
            const isStarted = event.type === 'item.started' || item.status === 'in_progress';
            const receiverIds = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.join(', ') : '';
            const detail = appendDetail(
                item["sender_thread_id"] ? `sender: ${item["sender_thread_id"]}` : '',
                receiverIds ? `receivers: ${receiverIds}` : '',
                formatJsonDetail('agents', item.agents_states),
                item.prompt ? `prompt: ${clipText(String(item.prompt), 300)}` : '',
            );
            labels.push({
                icon: isStarted ? '🤖' : '✅',
                label: isStarted ? `${tool}...` : `${tool} done`,
                toolType: 'subagent',
                stepRef: ref,
                status: isStarted ? 'running' : 'done',
                ...(detail ? { detail } : {}),
            });
        }
    }

    // [P0-1.3] Codex item.started: emit running label (paired with 1.4 stepRef)
    if (cli === 'codex' && event.type === 'item.started' && item) {
        if (item.type === 'command_execution') {
            const rawCommand = String(item.command || 'exec');
            const command = displayShellCommand(rawCommand);
            const ref = `codex:item:${item.id || rawCommand}`;
            labels.push({ icon: '🔧', label: buildPreview(command, 40) || 'exec', toolType: 'tool', stepRef: ref, status: 'running' });
        }
    }

    if (isClaudeLikeCli(cli)) {
        if (event.type === 'system') {
            const status = String(event.status || '');
            const subtype = String(event.subtype || event.event || '');
            if (subtype === 'task_started') {
                const taskId = event.task_id || event.id || event.tool_use_id || 'unknown';
                const description = event.description || event.input?.description || event.task_type || 'subagent';
                const detail = appendDetail(
                    event.task_type ? `type: ${event.task_type}` : '',
                    event.tool_use_id ? `tool_use_id: ${event.tool_use_id}` : '',
                    event.prompt ? `prompt: ${clipText(String(event.prompt), 300)}` : '',
                );
                pushToolLabel(labels, {
                    icon: '🤖',
                    label: `subagent: ${buildPreview(description, 60)}`,
                    toolType: 'subagent',
                    stepRef: `claude:task:${taskId}`,
                    status: 'running',
                    ...(detail ? { detail } : {}),
                }, cli, event, ctx);
            }
            if (subtype === 'task_notification') {
                const taskId = event.task_id || event.id || event.tool_use_id || 'unknown';
                const rawStatus = String(event.status || 'completed');
                const failed = ['failed', 'error', 'cancelled', 'canceled'].includes(rawStatus);
                const description = event.description || event.summary || event.task_type || 'subagent';
                const usage = event.usage || {};
                const usageDetail = [
                    usage.total_tokens != null ? `${usage.total_tokens} tok` : '',
                    usage["tool_uses"] != null ? `${usage["tool_uses"]} tools` : '',
                    usage.duration_ms != null ? `${(Number(usage.duration_ms) / 1000).toFixed(1)}s` : '',
                ].filter(Boolean).join(' · ');
                const detail = appendDetail(
                    event.summary ? `summary: ${event.summary}` : '',
                    event.output_file ? `output_file: ${event.output_file}` : '',
                    usageDetail,
                );
                pushToolLabel(labels, {
                    icon: failed ? '❌' : '✅',
                    label: `subagent: ${buildPreview(description, 60)}`,
                    toolType: 'subagent',
                    stepRef: `claude:task:${taskId}`,
                    status: failed ? 'error' : 'done',
                    ...(detail ? { detail } : {}),
                }, cli, event, ctx);
            }
            if (status === 'compacting' || subtype === 'compacting') {
                pushToolLabel(labels, { icon: '🗜️', label: 'compacting...', toolType: 'tool' }, cli, event, ctx);
            }
            if (status === 'compact_boundary' || subtype === 'compact_boundary' || event.compact_boundary === true) {
                pushToolLabel(labels, { icon: '✅', label: 'conversation compacted', toolType: 'tool', status: 'done' }, cli, event, ctx);
                if (ctx) ctx.cliNativeCompactDetected = true;
            }
        }
        if (event.type === 'stream_event' && event.event?.type === 'content_block_start') {
            if (ctx) ctx.hasClaudeStreamEvents = true;
            const cb = event.event.content_block;
            if (cb?.type === 'tool_use') {
                const isAgent = cb.name === 'Agent';
                pushToolLabel(labels, stripUndefined({
                    icon: isAgent ? '🤖' : '🔧',
                    label: isAgent ? 'subagent' : (cb.name || 'tool'),
                    toolType: isAgent ? 'subagent' : 'tool',
                    stepRef: cb.id ? `claude:tooluse:${cb.id}` : undefined,
                }), cli, event, ctx);
            }
            // thinking: don't emit placeholder — buffer in extractFromEvent will emit with real content
        }
        if (event.type === 'assistant' && event.message?.content && !ctx?.hasClaudeStreamEvents) {
            for (const block of event.message.content) {
                if (block.type === 'tool_use') {
                    const isAgent = block.name === 'Agent';
                    const description = block.input?.description || block.input?.["subagent_type"] || 'subagent';
                    const hasInput = Boolean(block.input && Object.keys(block.input).length > 0);
                    const toolDetail = isAgent
                        ? (block.input?.prompt ? `prompt: ${clipText(String(block.input.prompt), 300)}` : undefined)
                        : hasInput ? summarizeToolInput(block.name || 'tool', block.input || {}) : undefined;
                    pushToolLabel(labels, stripUndefined({
                        icon: isAgent ? '🤖' : '🔧',
                        label: isAgent ? `subagent: ${buildPreview(description, 60)}` : (block.name || 'tool'),
                        toolType: isAgent ? 'subagent' : 'tool',
                        stepRef: block.id ? `claude:tooluse:${block.id}` : undefined,
                        ...(toolDetail ? { detail: toolDetail } : {}),
                    }), cli, event, ctx);
                }
                if (block.type === 'thinking') {
                    pushToolLabel(labels, buildClaudeThinkingTool(block), cli, event, ctx);
                }
            }
        }
    }


    if (cli === 'opencode') {
        const isTaskToolUse = event.type === 'tool_use' && event.part?.tool === 'task';
        const isTaskToolResult = event.type === 'tool_result'
            && event.part?.callID
            && ctx?.opencodeTaskCallIds?.has(event.part.callID);

        if (isTaskToolUse || isTaskToolResult) {
            const part = asCliEventRecord(event.part);
            const callID = part.callID || part.id || 'task';
            if (isTaskToolResult && !part.state) return labels;
            if (isTaskToolUse && ctx) {
                if (!ctx.opencodeTaskCallIds) ctx.opencodeTaskCallIds = new Set();
                ctx.opencodeTaskCallIds.add(callID);
            }
            const state = part.state || {};
            const input = state.input || {};
            const status = String(state.status || (event.type === 'tool_result' ? 'completed' : 'completed'));
            const failed = isOpencodeToolFailure(part) || ['error', 'failed', 'cancelled', 'canceled'].includes(status);
            const subagentType = input["subagent_type"] || 'general';
            const description = input.description || state.title || part.tool || 'task';
            const resultText = event.type === 'tool_result'
                ? extractText(part.content || part.output || state.output)
                : '';
            const detail = appendDetail(
                formatOpenCodeTaskDetail(part),
                resultText ? `result: ${resultText}` : '',
            );
            labels.push({
                icon: failed ? '❌' : (status === 'running' || status === 'in_progress' ? '🤖' : '✅'),
                label: `subagent[${subagentType}]: ${buildPreview(description, 60)}`,
                toolType: 'subagent',
                stepRef: `opencode:call:${callID}`,
                ...(detail ? { detail } : {}),
                status: failed ? 'error' : (status === 'running' || status === 'in_progress' ? 'running' : 'done'),
            });
            return labels;
        }

        if (event.type === 'tool_use' && event.part) {
            const ref = event.part.callID
                ? `opencode:call:${event.part.callID}`
                : `opencode:tool:${event.part.tool || 'tool'}`;
            const detail = summarizeToolInput(event.part.tool || '', event.part.state?.input || {}, 0)
                || String(event.part.state?.output || '').trim();
            const isDone = event.part.state?.status === 'completed';
            const exitCode = fieldNumber(event.part.state?.metadata?.["exit"]);
            const isFailed = isOpencodeToolFailure(event.part);
            const displayLabel = fieldString(event.part.state?.title || event.part.tool, 'tool');
            labels.push(stripUndefined({
                icon: isFailed ? '❌' : (isDone ? '✅' : '🔧'),
                label: displayLabel,
                toolType: 'tool',
                stepRef: ref,
                detail,
                status: isFailed ? 'error' : (isDone ? 'done' : undefined),
                ...(exitCode != null ? { exitCode } : {}),
            }));
        }
        if (event.type === 'tool_result' && event.part) {
            const ref = event.part.callID
                ? `opencode:call:${event.part.callID}`
                : `opencode:tool:${event.part.tool || 'tool'}`;
            labels.push({ icon: '✅', label: fieldString(event.part.tool, 'done'), toolType: 'tool', stepRef: ref, status: 'done' });
        }
    }

    return labels;
}

// Backward-compat: return first label or null
export function extractToolLabel(cli: string, event: CliEventRecord): ToolEntry | null {
    const labels = extractToolLabels(cli, event);
    return labels[0] ?? null;
}

// Test-only helpers (keep parser logic private for runtime flow)
export function extractToolLabelsForTest(cli: string, event: CliEventRecord, ctx: SpawnContext = {
    fullText: '',
    traceLog: [],
    toolLog: [],
    seenToolKeys: new Set<string>(),
    hasClaudeStreamEvents: false,
    sessionId: null,
    cost: null,
    turns: null,
    duration: null,
    tokens: null,
    stderrBuf: '',
}) {
    return extractToolLabels(cli, event, ctx);
}

export function makeClaudeToolKeyForTest(event: CliEventRecord, label: ToolEntry) {
    return makeClaudeToolKey(event, label);
}
