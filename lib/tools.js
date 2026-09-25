/**
 * dsh-xiaozhi - MCP tool surface.
 *
 * Two weavings of the same capability inventory:
 *
 *   - `grouped` (default): one tool per **voice intent**, several related
 *     capabilities behind an `action` enum. A spoken request maps to a short,
 *     unambiguous tool list, which is what Xiaozhi's function-calling LLM
 *     actually needs.
 *   - `flat`: one tool per REST capability, for integrations that want the raw
 *     surface (and for tests that assert 1:1 coverage).
 *
 * Every tool answers with a single text block sized for speech: lists are
 * trimmed to `listLimit` rows, text is clipped to `maxVoiceChars`, and ids are
 * shortened so the model can still echo them back reliably.
 */
import { CAPABILITIES, CapabilityError, TOOL_GROUPS, getCapability, } from './capabilities.js';
import { canonicalToolName, clip, toolCallResult, } from './protocol.js';
// ---------------------------------------------------------------- formatting
function shortId(id) {
    const text = String(id ?? '');
    return text.length > 8 ? text.slice(0, 8) : text;
}
function relativeTime(at) {
    const ms = typeof at === 'number' && Number.isFinite(at) ? at : undefined;
    if (ms === undefined)
        return '未知时间';
    const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (seconds < 60)
        return `${seconds} 秒前`;
    if (seconds < 3600)
        return `${Math.round(seconds / 60)} 分钟前`;
    if (seconds < 86_400)
        return `${Math.round(seconds / 3600)} 小时前`;
    return `${Math.round(seconds / 86_400)} 天前`;
}
function asArray(value) {
    if (Array.isArray(value))
        return value;
    if (value !== null && typeof value === 'object') {
        const record = value;
        for (const key of ['items', 'sessions', 'workspaces', 'tools', 'presets', 'models', 'todos', 'messages']) {
            if (Array.isArray(record[key]))
                return record[key];
        }
    }
    return [];
}
/** Render at most `limit` rows plus an explicit "还有 N 条" tail. */
function renderRows(rows, limit, noun) {
    if (rows.length === 0)
        return `没有${noun}。`;
    const head = rows.slice(0, limit);
    const rest = rows.length - head.length;
    return rest > 0 ? `${head.join('\n')}\n（共 ${rows.length} 条，仅显示前 ${limit} 条）` : head.join('\n');
}
function renderSessionRow(raw) {
    const s = raw;
    const title = clip(String(s.title ?? s.name ?? '未命名会话'), 40);
    const status = s.status === 'running' ? '运行中' : '空闲';
    return `- ${title} [${shortId(s.id)}] ${status} · ${relativeTime(s.lastActivityAt ?? s.updatedAt)}`;
}
function renderWorkspaceRow(raw) {
    const w = raw;
    const title = clip(String(w.title ?? w.name ?? '未命名工作区'), 40);
    const count = Array.isArray(w.sessionIds) ? w.sessionIds.length : 0;
    return `- ${title} [${shortId(w.id)}] ${count} 个会话 · ${clip(String(w.path ?? ''), 60)}`;
}
function renderTodoRow(raw) {
    const t = raw;
    const mark = t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '▶' : '·';
    return `${mark} ${clip(String(t.content ?? ''), 50)}`;
}
function msToText(ms) {
    const n = typeof ms === 'number' && Number.isFinite(ms) ? ms : 0;
    if (n < 1000)
        return `${Math.round(n)} 毫秒`;
    return `${(n / 1000).toFixed(1)} 秒`;
}
const ACTION = (values, description) => ({
    type: 'string',
    enum: values,
    description,
});
const STR = (description) => ({ type: 'string', description });
const NUM = (description) => ({ type: 'number', description });
const BOOL = (description) => ({ type: 'boolean', description });
const GROUPED_TOOL_SPECS = [
    {
        name: 'dsh_status',
        description: '查询 DSH（DeepSeek Harness）的运行状态：是否在线、监听端口、工作区数量、可用模型，以及与小智的连接状态。用户问“DSH 在运行吗”“小智连上 DSH 了吗”“有哪些模型”时使用。',
        properties: {},
        required: [],
        write: false,
        groups: ['system'],
        capabilities: ['system.status'],
        async run(_args, runtime) {
            const status = (await runtime.run('system.status', {}));
            const mcp = (status.mcp ?? {});
            const lines = [
                `DSH ${mcp.connected ? '在线' : '运行中（小智未连接）'}，端口 ${status.port}。`,
                `工作区 ${status.workspacesCount} 个，可用模型提供商 ${(status.providers ?? []).length} 个。`,
                `小智 MCP：模式 ${mcp.mode ?? '-'}，状态 ${mcp.state ?? '-'}，暴露工具 ${mcp.toolCount ?? 0} 个。`,
            ];
            if (mcp.lastError)
                lines.push(`最近错误：${clip(String(mcp.lastError), 120)}`);
            return lines.join('\n');
        },
    },
    {
        name: 'dsh_workspaces',
        description: '管理 DSH 工作区（绑定一个本地目录）。action=list 列出全部工作区；get 看详情；create 新建（需要目录路径）；rename 改标题；delete 删除绑定；sessions 列出该工作区下的会话。',
        properties: {
            action: ACTION(['list', 'get', 'create', 'rename', 'delete', 'sessions'], '要执行的操作'),
            id: STR('工作区 ID（get/rename/delete/sessions 必填）'),
            path: STR('工作区目录的绝对路径（create 必填）'),
            title: STR('工作区标题（create/rename 使用）'),
        },
        required: ['action'],
        write: true,
        groups: ['workspaces'],
        capabilities: [
            'workspaces.list',
            'workspaces.get',
            'workspaces.create',
            'workspaces.update',
            'workspaces.delete',
            'workspaces.sessions',
        ],
        async run(args, runtime, config) {
            const action = String(args.action ?? '').toLowerCase();
            switch (action) {
                case 'list': {
                    const list = asArray(await runtime.run('workspaces.list', {}));
                    return renderRows(list.map(renderWorkspaceRow), config.listLimit, '工作区');
                }
                case 'get': {
                    const ws = (await runtime.run('workspaces.get', { id: args.id }));
                    return [
                        `工作区：${clip(String(ws.title ?? ''), 60)}`,
                        `ID：${ws.id}`,
                        `目录：${ws.path}`,
                        `会话数：${Array.isArray(ws.sessionIds) ? ws.sessionIds.length : 0}`,
                    ].join('\n');
                }
                case 'create': {
                    const ws = (await runtime.run('workspaces.create', { path: args.path, title: args.title }));
                    return `已创建工作区「${clip(String(ws.title ?? ''), 40)}」，ID ${ws.id}。`;
                }
                case 'rename': {
                    const ws = (await runtime.run('workspaces.update', { id: args.id, title: args.title }));
                    return `工作区已重命名为「${clip(String(ws.title ?? args.title ?? ''), 40)}」。`;
                }
                case 'delete':
                    await runtime.run('workspaces.delete', { id: args.id });
                    return '已删除该工作区绑定（磁盘目录未被删除）。';
                case 'sessions': {
                    const list = asArray(await runtime.run('workspaces.sessions', { id: args.id }));
                    return renderRows(list.map(renderSessionRow), config.listLimit, '会话');
                }
                default:
                    throw new CapabilityError(`action "${action}" 不支持，可用：list/get/create/rename/delete/sessions`);
            }
        },
    },
    {
        name: 'dsh_sessions',
        description: '管理 DSH 会话。action=list 列出或搜索会话（可用 search 关键词、workspaceId 过滤）；get 看详情与运行状态；create 新建会话（可指定工作区、标题、模型）；update 改标题或模型；delete 删除或归档；cancel 中止当前正在跑的轮次。',
        properties: {
            action: ACTION(['list', 'get', 'create', 'update', 'delete', 'cancel'], '要执行的操作'),
            id: STR('会话 ID（get/update/delete/cancel 必填）'),
            search: STR('按标题或 ID 搜索（list 使用）'),
            workspaceId: STR('按工作区过滤（list 使用）'),
            title: STR('会话标题（create/update 使用）'),
            cwd: STR('会话工作目录（create 使用，留空用默认目录）'),
            provider: STR('模型提供商（create/update 使用，例如 deepseek-official）'),
            model: STR('模型名（create/update 使用）'),
        },
        required: ['action'],
        write: true,
        groups: ['sessions'],
        capabilities: [
            'sessions.list',
            'sessions.get',
            'sessions.create',
            'sessions.update',
            'sessions.delete',
            'sessions.cancel',
        ],
        async run(args, runtime, config) {
            const action = String(args.action ?? '').toLowerCase();
            switch (action) {
                case 'list': {
                    const list = asArray(await runtime.run('sessions.list', {
                        search: args.search,
                        workspaceId: args.workspaceId,
                    }));
                    const filtered = list;
                    return renderRows(filtered.map(renderSessionRow), config.listLimit, '会话');
                }
                case 'get': {
                    const s = (await runtime.run('sessions.get', { id: args.id }));
                    return [
                        `会话：${clip(String(s.title ?? '未命名'), 60)}`,
                        `ID：${s.id}`,
                        `状态：${s.status === 'running' ? '运行中' : '空闲'}`,
                        `工作区：${s.workspaceId ?? '未归档'}`,
                        `模型：${s.model ? `${s.model.provider}/${s.model.model}` : '默认'}`,
                        `最近活动：${relativeTime(s.lastActivityAt ?? s.updatedAt)}`,
                    ].join('\n');
                }
                case 'create': {
                    const s = (await runtime.run('sessions.create', {
                        workspaceId: args.workspaceId,
                        cwd: args.cwd,
                        title: args.title,
                        provider: args.provider,
                        model: args.model,
                    }));
                    return `已创建会话「${clip(String(s.title ?? args.title ?? ''), 40)}」，ID ${s.id}。`;
                }
                case 'update': {
                    const s = (await runtime.run('sessions.update', {
                        id: args.id,
                        title: args.title,
                        provider: args.provider,
                        model: args.model,
                    }));
                    return `会话已更新：「${clip(String(s.title ?? args.title ?? ''), 40)}」。`;
                }
                case 'delete':
                    await runtime.run('sessions.delete', { id: args.id });
                    return '已删除／归档该会话。';
                case 'cancel':
                    await runtime.run('sessions.cancel', { id: args.id });
                    return '已请求中止该会话当前轮次。';
                default:
                    throw new CapabilityError(`action "${action}" 不支持，可用：list/get/create/update/delete/cancel`);
            }
        },
    },
    {
        name: 'dsh_session_progress',
        description: '查看某个 DSH 会话的运行进度：当前轮次/步骤、耗时、首 token 与吞吐、token 消耗，以及任务清单完成情况。用户问“那个会话跑到哪儿了”“任务做完了吗”时使用。',
        properties: { id: STR('会话 ID（必填）') },
        required: ['id'],
        write: false,
        groups: ['sessions'],
        capabilities: ['sessions.stats', 'sessions.todos'],
        async run(args, runtime, config) {
            const [stats, todos] = await Promise.all([
                runtime.run('sessions.stats', { id: args.id }).catch(() => undefined),
                runtime.run('sessions.todos', { id: args.id }).catch(() => undefined),
            ]);
            const lines = [];
            const todoData = (todos ?? {});
            lines.push(`运行状态：${todoData.running ? `执行中，已运行 ${msToText(todoData.elapsedMs)}` : '空闲'}。`);
            const counts = (todoData.counts ?? {});
            const todoList = asArray(todoData.todos);
            if (todoList.length > 0) {
                lines.push(`任务清单：完成 ${counts.completed ?? 0}，进行中 ${counts.inProgress ?? 0}，待办 ${counts.pending ?? 0}`);
                lines.push(renderRows(todoList.map(renderTodoRow), config.listLimit, '任务'));
            }
            else {
                lines.push('任务清单：空。');
            }
            const s = (stats ?? {});
            if (s && (s.turns !== undefined || s.steps !== undefined)) {
                lines.push(`统计：${s.turns ?? 0} 轮 / ${s.steps ?? 0} 步，模型耗时 ${msToText(s.llmMs)}，工具耗时 ${msToText(s.toolMs)}` +
                    (s.ttftSteps ? `，首 token 平均 ${msToText(s.ttftMs / s.ttftSteps)}` : ''));
                const usage = (s.usage ?? {});
                if (usage.outputTokens !== undefined) {
                    lines.push(`token：输入 ${usage.inputTokens ?? 0}，输出 ${usage.outputTokens ?? 0}，缓存命中 ${usage.cacheReadTokens ?? 0}`);
                }
            }
            return lines.join('\n');
        },
    },
    {
        name: 'dsh_session_history',
        description: '读取某个 DSH 会话最近的对话历史。用户问“那个会话刚才聊了什么”“上一轮结论是什么”时使用。',
        properties: {
            id: STR('会话 ID（必填）'),
            maxMessages: NUM('最多返回多少条消息，默认 8'),
            beforeSeq: NUM('只取该序号之前的消息，用于翻页'),
        },
        required: ['id'],
        write: false,
        groups: ['sessions'],
        capabilities: ['sessions.history'],
        async run(args, runtime, config) {
            const data = (await runtime.run('sessions.history', {
                id: args.id,
                maxMessages: args.maxMessages ?? Math.max(4, config.listLimit),
                beforeSeq: args.beforeSeq,
            }));
            const messages = asArray(data);
            if (messages.length === 0)
                return '该会话还没有历史消息。';
            const lines = messages.map(raw => {
                const m = raw;
                const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'DSH' : m.role === 'tool' ? '工具' : '系统';
                const text = clip(String(m.content ?? '').replace(/\s+/g, ' ').trim(), 200);
                return `${role}：${text || '（无文本内容）'}`;
            });
            return clip(lines.join('\n'), config.maxVoiceChars);
        },
    },
    {
        name: 'dsh_say',
        description: '向一个 DSH 会话发送指令或消息。wait=true（默认）会等整轮完成并返回 DSH 的回复；wait=false 会立即返回、由用户稍后再问进度。用户说“让小智去做…”“告诉那个会话…”时使用。这是一个可能耗时较久的操作。',
        properties: {
            id: STR('会话 ID（必填）'),
            prompt: STR('要发送给 DSH 的指令或消息（必填）'),
            wait: BOOL('是否等待整轮完成，默认 true'),
            mode: ACTION(['normal', 'steer'], 'normal=新开一轮；steer=插话到正在运行的轮次'),
            timeoutSeconds: NUM('等待上限（秒），默认 120'),
        },
        required: ['id', 'prompt'],
        write: true,
        groups: ['conversation'],
        capabilities: ['conversation.prompt', 'conversation.promptStream'],
        async run(args, runtime, config) {
            const id = String(args.id ?? '');
            const prompt = String(args.prompt ?? '');
            if (prompt.trim() === '')
                throw new CapabilityError('prompt 不能为空');
            const wait = args.wait === undefined ? true : Boolean(args.wait);
            const timeoutMs = Math.min(30 * 60_000, Math.max(5_000, Math.round(Number(args.timeoutSeconds ?? config.promptTimeoutMs / 1000) * 1000)));
            if (!wait) {
                // Submit through the streaming route with a short budget: the route is
                // aborted on our side while the agent keeps running in the background.
                await runtime
                    .run('conversation.promptStream', { id, prompt, mode: args.mode, timeoutMs: 1_500 })
                    .catch(() => undefined);
                const session = (await runtime.run('sessions.get', { id }).catch(() => undefined));
                return session?.status === 'running'
                    ? '已把指令发给该会话，DSH 正在处理。稍后可以再问进度。'
                    : '已把指令发给该会话。';
            }
            const result = (await runtime.run('conversation.prompt', {
                id,
                prompt,
                mode: args.mode,
                timeoutMs,
            }));
            const content = String(result?.content ?? '').trim();
            const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
            const head = content === '' ? 'DSH 本轮没有返回文本内容。' : content;
            const tail = toolCalls.length > 0 ? `\n（本轮调用了 ${toolCalls.length} 次工具）` : '';
            return clip(`${head}${tail}`, config.maxVoiceChars);
        },
    },
    {
        name: 'dsh_questions',
        description: '处理 DSH 会话里等待用户回答的提问。action=list 查看当前挂起的问题及可选项；action=answer 提交答复让会话继续（可用 choice 选一个选项，或用 custom 自由填写，也可用 answers 传 JSON 数组）。',
        properties: {
            action: ACTION(['list', 'answer'], '要执行的操作'),
            id: STR('会话 ID（必填）'),
            batchId: STR('提问批次 ID（answer 使用，省略则答复最早一批）'),
            choice: STR('选择的选项文本（answer 使用）'),
            custom: STR('自由填写的答复文本（answer 使用）'),
            answers: STR('符合接口格式的 JSON 数组字符串，如 [{"id":"q1","selected":["A"]}]（answer 使用）'),
        },
        required: ['action', 'id'],
        write: true,
        groups: ['sessions'],
        capabilities: ['sessions.questions', 'sessions.answers'],
        async run(args, runtime) {
            const id = String(args.id ?? '');
            const action = String(args.action ?? '').toLowerCase();
            if (action === 'list') {
                const data = (await runtime.run('sessions.questions', { id }));
                const batches = asArray(data?.batches);
                if (batches.length === 0)
                    return '该会话当前没有等待回答的问题。';
                const lines = [`共有 ${batches.length} 批待回答的问题：`];
                for (const raw of batches) {
                    const batch = raw;
                    lines.push(`批次 ${shortId(batch.batchId)}：`);
                    for (const q of asArray(batch.questions)) {
                        const question = q;
                        const options = asArray(question.options)
                            .map(option => {
                            if (option !== null && typeof option === 'object') {
                                const o = option;
                                return String(o.label ?? o.value ?? o.title ?? '');
                            }
                            return String(option);
                        })
                            .filter(Boolean);
                        lines.push(`- ${clip(String(question.question ?? ''), 120)}（id ${shortId(question.id)}）` +
                            (options.length > 0 ? ` 选项：${options.join(' / ')}` : ''));
                    }
                }
                return clip(lines.join('\n'), 1_200);
            }
            if (action !== 'answer') {
                throw new CapabilityError(`action "${action}" 不支持，可用：list/answer`);
            }
            let answers;
            if (typeof args.answers === 'string' && args.answers.trim() !== '') {
                try {
                    const parsed = JSON.parse(args.answers);
                    if (!Array.isArray(parsed))
                        throw new Error('answers 必须是 JSON 数组');
                    answers = parsed.map((item) => ({
                        id: String(item?.id ?? ''),
                        selected: Array.isArray(item?.selected) ? item.selected.map(String) : [],
                        ...(typeof item?.custom === 'string' && item.custom !== '' ? { custom: item.custom } : {}),
                    }));
                }
                catch (err) {
                    throw new CapabilityError(`answers 解析失败：${err.message}`);
                }
            }
            if (!answers) {
                const pending = (await runtime.run('sessions.questions', { id }));
                const batch = (asArray(pending?.batches)[0] ?? undefined);
                if (!batch)
                    throw new CapabilityError('该会话当前没有挂起的问题');
                const choice = typeof args.choice === 'string' && args.choice.trim() !== '' ? args.choice.trim() : undefined;
                const custom = typeof args.custom === 'string' && args.custom.trim() !== '' ? args.custom.trim() : undefined;
                if (choice === undefined && custom === undefined) {
                    throw new CapabilityError('answer 需要提供 choice、custom 或 answers 之一');
                }
                answers = asArray(batch.questions).map((raw, index) => {
                    const question = raw;
                    const first = index === 0;
                    return {
                        id: String(question.id ?? ''),
                        selected: first && choice !== undefined ? [choice] : [],
                        ...(first && custom !== undefined ? { custom } : {}),
                    };
                });
            }
            await runtime.run('sessions.answers', {
                id,
                batchId: args.batchId,
                answers,
            });
            return `已提交 ${answers.length} 个答复，会话已继续。`;
        },
    },
    {
        name: 'dsh_session_files',
        description: '管理 DSH 会话工作区里的文件。action=list 列出目录；action=read 读取一个文本文件的内容；action=upload 上传文件（内容用 base64 或纯文本传入）。',
        properties: {
            action: ACTION(['list', 'read', 'upload'], '要执行的操作'),
            id: STR('会话 ID（必填）'),
            path: STR('相对于会话工作区的路径；list 省略表示根目录，read/upload 必填'),
            content: STR('文件内容（upload 使用）'),
            encoding: ACTION(['base64', 'utf8'], 'content 的编码方式，默认 base64'),
            filename: STR('上传后的文件名（upload 使用，省略则用 path）'),
        },
        required: ['action', 'id'],
        write: true,
        groups: ['files'],
        capabilities: ['files.list', 'files.download', 'files.upload'],
        async run(args, runtime) {
            const id = String(args.id ?? '');
            const action = String(args.action ?? '').toLowerCase();
            switch (action) {
                case 'list': {
                    const data = (await runtime.run('files.list', { id, path: args.path }));
                    const entries = asArray(data?.entries ?? data);
                    if (entries.length === 0)
                        return '目录为空。';
                    const lines = entries.map(raw => {
                        if (typeof raw === 'string')
                            return `- ${raw}`;
                        const e = raw;
                        const kind = e.type === 'directory' || e.isDirectory ? '目录' : '文件';
                        const size = typeof e.size === 'number' ? ` ${e.size} 字节` : '';
                        return `- ${kind} ${e.name ?? e.path}${size}`;
                    });
                    return renderRows(lines, 40, '条目');
                }
                case 'read': {
                    const text = await runtime.run('files.download', { id, path: args.path });
                    return clip(typeof text === 'string' ? text : JSON.stringify(text), 1_200);
                }
                case 'upload': {
                    const result = (await runtime.run('files.upload', {
                        id,
                        path: args.path,
                        filename: args.filename ?? args.path,
                        content: args.content,
                        encoding: args.encoding ?? 'base64',
                    }));
                    const saved = asArray(result?.files ?? result)
                        .map(raw => String(raw?.name ?? raw?.path ?? ''))
                        .filter(Boolean);
                    return `已上传：${saved.join('、') || String(args.filename ?? args.path ?? '')}`;
                }
                default:
                    throw new CapabilityError(`action "${action}" 不支持，可用：list/read/upload`);
            }
        },
    },
    {
        name: 'dsh_session_skills',
        description: '查看某个 DSH 会话可用的技能目录（技能名、描述与来源）。',
        properties: {
            id: STR('会话 ID（必填）'),
            search: STR('按名称或描述过滤'),
        },
        required: ['id'],
        write: false,
        groups: ['sessions'],
        capabilities: ['sessions.skills'],
        async run(args, runtime, config) {
            const data = (await runtime.run('sessions.skills', { id: args.id, search: args.search }));
            const skills = asArray(data?.skills ?? data);
            if (skills.length === 0)
                return '没有可用技能。';
            const lines = skills.map(raw => {
                const s = raw;
                return `- ${s.name}（${s.source ?? 'skill'}）：${clip(String(s.description ?? ''), 60)}`;
            });
            return renderRows(lines, config.listLimit, '技能');
        },
    },
    {
        name: 'dsh_session_watch',
        description: '在几秒内监听某个 DSH 会话发生的事件（工具调用、轮次开始与结束、报错等），用来判断它是否还在干活、刚刚做了什么。',
        properties: {
            id: STR('会话 ID（必填）'),
            seconds: NUM('监听时长（秒），默认 5，最大 30'),
        },
        required: ['id'],
        write: false,
        groups: ['sessions'],
        capabilities: ['sessions.events'],
        async run(args, runtime) {
            const data = (await runtime.run('sessions.events', { id: args.id, seconds: args.seconds }));
            const lines = [`${data.windowSeconds} 秒内共 ${data.totalEvents} 个事件。`];
            const byType = (data.byType ?? {});
            const top = Object.entries(byType)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6)
                .map(([type, n]) => `${type}×${n}`);
            if (top.length > 0)
                lines.push(`事件类型：${top.join('，')}`);
            for (const raw of asArray(data.events).slice(-8)) {
                const e = raw;
                if (e.summary)
                    lines.push(`- ${e.summary}`);
            }
            if (data.note)
                lines.push(String(data.note));
            return clip(lines.join('\n'), 900);
        },
    },
    {
        name: 'dsh_chat',
        description: '用一次性问题直接问 DSH（OpenAI 兼容的一次性对话，不新建可见会话，也可用 sessionId 复用已有会话）。适合“问 DSH 一个问题”而不用挑会话。',
        properties: {
            prompt: STR('要问 DSH 的内容（必填）'),
            sessionId: STR('复用已有会话的 ID（可选）'),
            model: STR('指定模型名（可选）'),
        },
        required: ['prompt'],
        write: true,
        groups: ['conversation'],
        capabilities: ['conversation.chat'],
        async run(args, runtime, config) {
            const prompt = String(args.prompt ?? '');
            if (prompt.trim() === '')
                throw new CapabilityError('prompt 不能为空');
            const result = (await runtime.run('conversation.chat', {
                messages: [{ role: 'user', content: prompt }],
                sessionId: args.sessionId,
                model: args.model,
                stream: false,
            }));
            const content = String(result?.choices?.[0]?.message?.content ?? '').trim();
            return clip(content === '' ? 'DSH 没有返回内容。' : content, config.maxVoiceChars);
        },
    },
    {
        name: 'dsh_models',
        description: '查看或切换 DSH 使用的模型。action=list 列出可用模型；default 查看当前默认模型；set_default 切换默认模型（需要 provider 与 model）。',
        properties: {
            action: ACTION(['list', 'default', 'set_default'], '要执行的操作'),
            provider: STR('模型提供商 ID（set_default 必填）'),
            model: STR('模型名（set_default 必填）'),
            reasoningEffort: STR('推理强度 ID（可选）'),
        },
        required: ['action'],
        write: true,
        groups: ['models'],
        capabilities: ['models.list', 'models.default', 'models.setDefault'],
        async run(args, runtime, config) {
            const action = String(args.action ?? '').toLowerCase();
            if (action === 'list') {
                const data = (await runtime.run('models.list', {}));
                const models = asArray(data?.models ?? data);
                const lines = models.map(raw => {
                    const m = raw;
                    const mark = m.isDefault ? '★ ' : '';
                    return `- ${mark}${m.provider}/${m.id}${m.name ? `（${clip(String(m.name), 30)}）` : ''}`;
                });
                const text = renderRows(lines, Math.max(config.listLimit, 15), '模型');
                const def = data?.default ?? data?.defaultModel;
                return def ? `默认模型：${def.provider}/${def.model}\n${text}` : text;
            }
            if (action === 'default') {
                const def = (await runtime.run('models.default', {}));
                return `当前默认模型：${def?.provider ?? '?'}/${def?.model ?? '?'}${def?.reasoningEffort ? `（推理强度 ${def.reasoningEffort}）` : ''}`;
            }
            if (action === 'set_default') {
                const updated = (await runtime.run('models.setDefault', {
                    provider: args.provider,
                    model: args.model,
                    reasoningEffort: args.reasoningEffort,
                }));
                return `默认模型已切换为 ${updated?.provider ?? args.provider}/${updated?.model ?? args.model}。`;
            }
            throw new CapabilityError(`action "${action}" 不支持，可用：list/default/set_default`);
        },
    },
    {
        name: 'dsh_providers',
        description: '列出 DSH 已注册的 LLM 提供商及其模型数量。',
        properties: {},
        required: [],
        write: false,
        groups: ['models'],
        capabilities: ['models.providers'],
        async run(_args, runtime, config) {
            const list = asArray(await runtime.run('models.providers', {}));
            const lines = list.map(raw => {
                const p = raw;
                const count = Array.isArray(p.models) ? p.models.length : 0;
                return `- ${p.displayName ?? p.id}（${p.id}，${count} 个模型）`;
            });
            return renderRows(lines, Math.max(config.listLimit, 15), '提供商');
        },
    },
    {
        name: 'dsh_presets',
        description: '列出 DSH 可用的 Agent Preset（智能体预设），新建会话时可以选用。',
        properties: {},
        required: [],
        write: false,
        groups: ['models'],
        capabilities: ['models.presets'],
        async run(_args, runtime, config) {
            const data = (await runtime.run('models.presets', {}));
            const presets = asArray(data?.presets ?? data);
            if (presets.length === 0)
                return '没有可用的 Agent Preset。';
            const lines = presets.map(raw => {
                const p = raw;
                const mark = p.isDefault ? '★ ' : '';
                return `- ${mark}${p.name ?? p.id}：${clip(String(p.description ?? ''), 60)}`;
            });
            return renderRows(lines, config.listLimit, '预设');
        },
    },
    {
        name: 'dsh_settings',
        description: '读取或修改 DSH 系统设置。action=get 列出所有设置命名空间；action=patch 更新指定命名空间（namespace 必填，patch 是 JSON 对象字符串）。',
        properties: {
            action: ACTION(['get', 'patch'], '要执行的操作'),
            namespace: STR('设置命名空间（patch 必填，例如 agent-default-model）'),
            patch: STR('要合并进去的设置，JSON 对象字符串，例如 {"model":"glm-5.3"}'),
        },
        required: ['action'],
        write: true,
        groups: ['settings'],
        capabilities: ['settings.get', 'settings.patch'],
        async run(args, runtime, config) {
            const action = String(args.action ?? '').toLowerCase();
            if (action === 'get') {
                const data = (await runtime.run('settings.get', {}));
                const namespaces = asArray(data?.namespaces);
                if (namespaces.length === 0)
                    return '没有可读取的设置命名空间。';
                const lines = namespaces.map(raw => {
                    const ns = raw;
                    return `- ${ns.ns}`;
                });
                return renderRows(lines, Math.max(config.listLimit, 20), '设置命名空间');
            }
            if (action === 'patch') {
                const namespace = String(args.namespace ?? '').trim();
                if (namespace === '')
                    throw new CapabilityError('namespace 必填');
                let patch;
                try {
                    patch = typeof args.patch === 'string' ? JSON.parse(args.patch) : args.patch;
                }
                catch (err) {
                    throw new CapabilityError(`patch 解析失败：${err.message}`);
                }
                if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
                    throw new CapabilityError('patch 必须是 JSON 对象');
                }
                await runtime.run('settings.patch', { namespace, patch });
                return `已更新设置命名空间 ${namespace}。`;
            }
            throw new CapabilityError(`action "${action}" 不支持，可用：get/patch`);
        },
    },
    {
        name: 'dsh_docs',
        description: '获取 DSH 内置 API 文档与 OpenAPI 规范的访问地址，以及本插件当前暴露给小智的全部能力清单。',
        properties: {},
        required: [],
        write: false,
        groups: ['docs'],
        capabilities: ['docs.info', 'docs.openapi'],
        async run(_args, runtime) {
            const info = (await runtime.run('docs.info', {}));
            const lines = [
                `交互式文档：${info.docsUrl}`,
                `OpenAPI 规范：${info.openApiUrl}`,
                `共 ${info.totalCapabilities} 项能力，分为 ${(info.groups ?? []).length} 组。`,
            ];
            const spec = (await runtime.run('docs.openapi', {}).catch(() => undefined));
            if (spec?.openapi) {
                lines.push(`OpenAPI ${spec.openapi}：${spec.pathCount} 条路径，约 ${Math.round((spec.bytes ?? 0) / 1024)} KB。`);
            }
            else if (spec?.note) {
                lines.push(String(spec.note));
            }
            return lines.join('\n');
        },
    },
];
/** Per-capability parameter docs for `toolMode: flat`, derived from the route contract. */
const FLAT_PARAM_DOCS = {
    'workspaces.create': {
        path: { type: 'string', description: '工作区目录的绝对路径', required: true },
        title: { type: 'string', description: '工作区标题' },
    },
    'workspaces.update': { title: { type: 'string', description: '新的工作区标题', required: true } },
    'sessions.list': {
        search: { type: 'string', description: '按标题或 ID 搜索' },
        workspaceId: { type: 'string', description: '按工作区过滤' },
        limit: { type: 'number', description: '最多返回条数' },
    },
    'sessions.create': {
        workspaceId: { type: 'string', description: '所属工作区 ID' },
        cwd: { type: 'string', description: '会话工作目录' },
        title: { type: 'string', description: '会话标题' },
        provider: { type: 'string', description: '模型提供商 ID' },
        model: { type: 'string', description: '模型名' },
        reasoningEffort: { type: 'string', description: '推理强度 ID' },
        agentPreset: { type: 'string', description: 'Agent Preset ID' },
    },
    'sessions.update': {
        title: { type: 'string', description: '新的标题' },
        provider: { type: 'string', description: '新的模型提供商' },
        model: { type: 'string', description: '新的模型名' },
        reasoningEffort: { type: 'string', description: '新的推理强度' },
    },
    'sessions.history': {
        maxMessages: { type: 'number', description: '最多返回多少条消息' },
        beforeSeq: { type: 'number', description: '只取该序号之前的消息' },
        throughSeq: { type: 'number', description: '只取到该序号为止的消息' },
    },
    'sessions.skills': { search: { type: 'string', description: '按名称或描述过滤' } },
    'sessions.answers': {
        batchId: { type: 'string', description: '提问批次 ID，省略则答复最早一批' },
        answers: {
            type: 'array',
            description: '答复数组：[{id, selected:[], custom?}]',
            required: true,
            items: { type: 'object' },
        },
    },
    'sessions.events': { seconds: { type: 'number', description: '监听时长（秒），默认 5，最大 30' } },
    'files.list': { path: { type: 'string', description: '相对子目录，省略为根目录' } },
    'files.download': {
        path: { type: 'string', description: '相对路径', required: true },
        inline: { type: 'string', description: '置 1 时按浏览器内联预览' },
    },
    'files.upload': {
        filename: { type: 'string', description: '上传后的文件名', required: true },
        content: { type: 'string', description: '文件内容（base64 或纯文本）', required: true },
        encoding: { type: 'string', description: 'content 的编码：base64（默认）或 utf8', enum: ['base64', 'utf8'] },
    },
    'conversation.prompt': {
        prompt: { type: 'string', description: '提示词', required: true },
        mode: { type: 'string', description: 'normal 或 steer', enum: ['normal', 'steer'] },
        timeoutMs: { type: 'number', description: '等待上限（毫秒）' },
        images: { type: 'array', description: '图片数组 [{mimeType,data}]', items: { type: 'object' } },
    },
    'conversation.promptStream': {
        prompt: { type: 'string', description: '提示词', required: true },
        mode: { type: 'string', description: 'normal 或 steer', enum: ['normal', 'steer'] },
        timeoutMs: { type: 'number', description: '等待上限（毫秒）' },
        images: { type: 'array', description: '图片数组 [{mimeType,data}]', items: { type: 'object' } },
    },
    'conversation.chat': {
        messages: {
            type: 'array',
            description: 'OpenAI 格式消息数组 [{role, content}]',
            required: true,
            items: { type: 'object' },
        },
        model: { type: 'string', description: '模型名' },
        sessionId: { type: 'string', description: '复用已有会话 ID' },
        max_tokens: { type: 'number', description: '最大输出 token' },
        stream: { type: 'boolean', description: '是否流式（MCP 场景请用 false）' },
    },
    'models.setDefault': {
        provider: { type: 'string', description: '提供商 ID', required: true },
        model: { type: 'string', description: '模型名', required: true },
        reasoningEffort: { type: 'string', description: '推理强度 ID' },
    },
    'settings.patch': {
        namespace: { type: 'string', description: '设置命名空间', required: true },
        patch: { type: 'object', description: '要合并进去的设置对象', required: true },
    },
};
function defaultFlatParam(name, spec) {
    const isPath = spec.pathParams.includes(name);
    const numeric = /(Ms|seq|Seq|seconds|limit|Messages)$/.test(name);
    return {
        type: numeric ? 'number' : 'string',
        description: isPath ? `路径参数 ${name}` : `参数 ${name}`,
        required: isPath,
    };
}
/** `dsh_<group>_<verb>` derived from the dotted capability id. */
function flatToolName(spec) {
    return canonicalToolName(`dsh_${spec.id.replace(/\./g, '_')}`);
}
function buildFlatSpec(spec) {
    const docs = FLAT_PARAM_DOCS[spec.id] ?? {};
    const names = [...new Set([...spec.pathParams, ...spec.queryParams, ...spec.bodyFields])];
    const properties = {};
    const required = [];
    for (const name of names) {
        if (spec.id === 'settings.patch' && name === 'patch')
            continue; // handled below
        const doc = docs[name] ?? defaultFlatParam(name, spec);
        const schema = { type: doc.type, description: doc.description };
        if (doc.enum)
            schema.enum = doc.enum;
        if (doc.items)
            schema.items = doc.items;
        properties[name] = schema;
        if (doc.required || spec.pathParams.includes(name))
            required.push(name);
    }
    if (spec.id === 'settings.patch') {
        properties.patch = { type: 'object', description: docs.patch?.description ?? '设置对象' };
        required.push('patch');
    }
    return {
        name: flatToolName(spec),
        description: `${spec.summary}${spec.write ? '（写操作）' : ''}。对应 DSH Web 接口 ${spec.method} ${spec.path}。`,
        inputSchema: { type: 'object', properties, required },
        write: spec.write,
        groups: [spec.group],
        capabilities: [spec.id],
    };
}
/** Build the tool list for the configured mode, filtered by group and write flags. */
export function buildTools(config) {
    const groupDisabled = (id) => {
        const cap = getCapability(id);
        return cap === undefined || config.disabledGroups.includes(cap.group);
    };
    const writeDisabled = (id) => getCapability(id)?.write === true && !config.allowWriteTools;
    if (config.toolMode === 'flat') {
        const tools = CAPABILITIES.filter(spec => !config.disabledGroups.includes(spec.group))
            .filter(spec => config.allowWriteTools || !spec.write)
            .map(buildFlatSpec);
        return { mode: 'flat', tools, groupedRunners: new Map() };
    }
    const tools = [];
    const groupedRunners = new Map();
    for (const spec of GROUPED_TOOL_SPECS) {
        // Keep a mixed tool as long as one of its capabilities survives: turning
        // writes off must not also hide "list workspaces" just because the same
        // tool can also create one. Disabled write *actions* are still rejected at
        // call time by CapabilityRuntime, with a speakable error.
        const capabilities = spec.capabilities.filter(id => !groupDisabled(id) && !writeDisabled(id));
        if (capabilities.length === 0)
            continue;
        const hasDisabledWrites = !config.allowWriteTools && spec.capabilities.some(id => getCapability(id)?.write === true);
        tools.push({
            name: canonicalToolName(spec.name),
            description: hasDisabledWrites
                ? `${spec.description}（注意：本次部署已关闭写入操作，create/update/delete/发送类动作会失败）`
                : spec.description,
            inputSchema: {
                type: 'object',
                properties: spec.properties,
                required: spec.required,
            },
            write: capabilities.some(id => getCapability(id)?.write === true),
            groups: spec.groups,
            capabilities,
        });
        groupedRunners.set(canonicalToolName(spec.name), spec);
    }
    return { mode: 'grouped', tools, groupedRunners };
}
export class ToolRunner {
    deps;
    built;
    constructor(deps) {
        this.deps = deps;
        this.built = buildTools(deps.config());
    }
    /** Rebuild after a config change. */
    refresh() {
        this.built = buildTools(this.deps.config());
    }
    get mode() {
        return this.built.mode;
    }
    list() {
        return this.built.tools;
    }
    /** MCP `tools/list` payload. */
    definitions() {
        return this.built.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        }));
    }
    async call(name, args) {
        const requested = String(name ?? '');
        const tool = this.built.tools.find(item => item.name === requested) ??
            this.built.tools.find(item => item.name === canonicalToolName(requested)) ??
            this.built.tools.find(item => item.name === xiaozhiAlias(requested));
        if (!tool) {
            return toolCallResult(`没有名为 ${requested} 的工具。可用工具：${this.built.tools.map(t => t.name).join('、')}`, true);
        }
        const started = Date.now();
        try {
            const value = await this.runTool(tool, args ?? {});
            this.logCall(tool.name, args, 'ok', Date.now() - started);
            return toolCallResult(value);
        }
        catch (err) {
            const message = err instanceof CapabilityError
                ? err.message
                : err?.message ?? String(err);
            this.logCall(tool.name, args, `error: ${message}`, Date.now() - started);
            return toolCallResult(`执行 ${tool.name} 失败：${message}`, true);
        }
    }
    async runTool(tool, args) {
        const config = this.deps.config();
        if (this.built.mode === 'flat') {
            if (tool.write && !config.allowWriteTools) {
                throw new CapabilityError('写入类工具已关闭（allowWriteTools=false）');
            }
            const spec = getCapability(tool.capabilities[0] ?? '');
            if (!spec)
                throw new CapabilityError(`工具 ${tool.name} 未绑定能力`);
            return this.deps.runtime.run(spec.id, args);
        }
        // Grouped tools may mix read and write actions; each dispatched capability
        // re-checks `allowWriteTools` in CapabilityRuntime, so a mixed tool stays
        // usable for its read actions instead of disappearing entirely.
        const runner = this.built.groupedRunners.get(tool.name);
        if (!runner)
            throw new CapabilityError(`工具 ${tool.name} 未注册执行器`);
        const value = await runner.run(args, this.deps.runtime, config);
        return clampVoice(value, config);
    }
    logCall(name, args, outcome, ms) {
        if (!this.deps.config().logToolCalls)
            return;
        this.deps.log?.(`tool ${name} ${outcome} in ${ms}ms args=${safeJson(args)}`);
    }
}
/** Xiaozhi rewrites illegal characters in tool names; accept that spelling too. */
function xiaozhiAlias(name) {
    return canonicalToolName(String(name).replace(/[\u4e00-\u9fff]/g, '_'));
}
function safeJson(value) {
    try {
        const text = JSON.stringify(value);
        return text === undefined ? 'undefined' : clip(text, 300);
    }
    catch {
        return '<unserialisable>';
    }
}
function clampVoice(value, config) {
    if (typeof value === 'string' && value.length > config.maxVoiceChars) {
        return clip(value, config.maxVoiceChars);
    }
    return value;
}
/** Capability ids covered by the current tool weaving (coverage assertions). */
export function coveredCapabilityIds(tools) {
    const ids = new Set();
    for (const tool of tools)
        for (const id of tool.capabilities)
            ids.add(id);
    return ids;
}
export { TOOL_GROUPS, CAPABILITIES };
//# sourceMappingURL=tools.js.map