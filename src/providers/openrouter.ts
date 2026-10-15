import { requestUrl } from 'obsidian';
import { StellaSettings } from '../types';
import { LLMProviderWithMCP, MCPContext, ProviderContext, StreamCallbacks } from './types';

/**
 * OpenRouter provider — one API key, hundreds of models from many vendors,
 * all behind an OpenAI-compatible chat completions endpoint.
 *
 * OpenRouter answers CORS preflights for any origin, so plain `fetch` works
 * from Obsidian (and is needed for streaming). Model ids look like
 * `anthropic/claude-sonnet-5` or `openai/gpt-5`.
 */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// Optional attribution headers — OpenRouter shows the app name in its
// dashboard and activity log.
const ATTRIBUTION_HEADERS = {
    'HTTP-Referer': 'https://github.com/PoweredbyPugs/Stella-Obsidian-Chat',
    'X-Title': 'Bulbasaur Chat',
};

/** List every model id OpenRouter offers, alphabetically. No key needed. */
export async function listOpenRouterModels(): Promise<string[]> {
    const response = await requestUrl({ url: `${OPENROUTER_BASE}/models`, throw: false });
    if (response.status !== 200) {
        throw new Error(`OpenRouter models error: HTTP ${response.status}`);
    }
    const ids: string[] = (response.json?.data || [])
        .map((m: any) => m?.id)
        .filter((id: any) => typeof id === 'string' && id.length > 0);
    return ids.sort((a, b) => a.localeCompare(b));
}

// Tool-call round trips allowed per reply before the model must answer.
const MAX_TOOL_ROUNDS = 8;

/**
 * MCP tools as OpenAI-style function definitions. Function names must match
 * ^[a-zA-Z0-9_-]{1,64}$, but ours are `${server}_${tool}` and server names
 * have spaces ("Stella Astrology Server"), so each gets a safe name and
 * `originalNames` maps it back for executeTool.
 */
function buildOpenAITools(mcpContext: MCPContext): { tools: any[]; originalNames: Map<string, string> } {
    const tools: any[] = [];
    const originalNames = new Map<string, string>();
    for (const server of mcpContext.servers) {
        for (const tool of server.tools) {
            const original = `${server.name}_${tool.name}`;
            let name = original.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
            for (let i = 2; originalNames.has(name); i++) {
                name = `${name.slice(0, 60)}_${i}`;
            }
            originalNames.set(name, original);

            const { $schema, ...parameters } = tool.inputSchema || {};
            tools.push({
                type: 'function',
                function: {
                    name,
                    description: tool.description || `Execute ${tool.name} from ${server.name}`,
                    parameters: parameters.type ? parameters : { type: 'object', properties: {} },
                },
            });
        }
    }
    return { tools, originalNames };
}

export class OpenRouterProvider implements LLMProviderWithMCP {
    name = 'openrouter';

    isConfigured(settings: StellaSettings): boolean {
        return !!settings.openrouterApiKey;
    }

    private buildRequest(settings: StellaSettings, messages: ProviderContext['messages'], stream: boolean): RequestInit {
        if (!settings.openrouterApiKey) {
            throw new Error('Please set your OpenRouter API key in settings');
        }
        if (!settings.model) {
            throw new Error('Please pick an OpenRouter model in settings');
        }
        return {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.openrouterApiKey}`,
                ...ATTRIBUTION_HEADERS,
            },
            body: JSON.stringify({
                model: settings.model,
                messages,
                max_tokens: settings.maxTokens,
                temperature: settings.temperature,
                stream,
            }),
        };
    }

    private async errorFrom(response: Response): Promise<Error> {
        const text = await response.text();
        let detail = text;
        try {
            detail = JSON.parse(text)?.error?.message || text;
        } catch { /* not JSON */ }
        return new Error(`OpenRouter error (${response.status}): ${detail}`);
    }

    async call(context: ProviderContext): Promise<string> {
        const { settings, messages } = context;
        const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, { ...this.buildRequest(settings, messages, false), signal: context.signal });
        if (!response.ok) throw await this.errorFrom(response);

        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
    }

    /**
     * Non-streaming call with MCP tools offered as OpenAI-style `tools`.
     * Loops: whenever the model answers with `tool_calls`, run each one,
     * hand the results back as `tool` messages, and ask again — until it
     * answers in plain text or MAX_TOOL_ROUNDS is reached.
     *
     * Without `tools` in the request, models that know tools only from the
     * system prompt (e.g. DeepSeek) write their native call markup into the
     * reply as text instead of calling anything.
     */
    async callWithMCP(context: ProviderContext, mcpContext: MCPContext): Promise<string> {
        const { settings, signal } = context;
        const { tools, originalNames } = buildOpenAITools(mcpContext);
        if (tools.length === 0) return this.call(context);

        const messages: any[] = [...context.messages];
        const request = (withTools: boolean) => {
            const init = this.buildRequest(settings, messages, false);
            const body = JSON.parse(init.body as string);
            if (withTools) body.tools = tools;
            return fetch(`${OPENROUTER_BASE}/chat/completions`, { ...init, body: JSON.stringify(body), signal });
        };

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
            // The last round withholds tools so the model has to answer.
            const response = await request(round < MAX_TOOL_ROUNDS);
            if (!response.ok) throw await this.errorFrom(response);

            const data = await response.json();
            const message = data.choices?.[0]?.message;
            const toolCalls: any[] = message?.tool_calls || [];
            if (toolCalls.length === 0) return message?.content || '';

            // Send the assistant turn back as-is: reasoning models need their
            // reasoning fields echoed alongside the tool calls.
            messages.push(message);
            for (const call of toolCalls) {
                const name = call.function?.name || '';
                let content: string;
                try {
                    const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
                    const result = await mcpContext.executeTool(originalNames.get(name) || name, args);
                    content = typeof result === 'string' ? result : JSON.stringify(result);
                } catch (error: any) {
                    content = `Error: ${error?.message || error}`;
                }
                messages.push({ role: 'tool', tool_call_id: call.id, content });
            }
        }
        return '';
    }

    // Tool calls run non-streamed; the finished reply arrives in one piece.
    async streamWithMCP(context: ProviderContext, callbacks: StreamCallbacks, mcpContext: MCPContext): Promise<void> {
        callbacks.onContent(await this.callWithMCP(context, mcpContext));
        await callbacks.onComplete();
    }

    async stream(context: ProviderContext, callbacks: StreamCallbacks): Promise<void> {
        const { settings, messages } = context;
        const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, { ...this.buildRequest(settings, messages, true), signal: context.signal });
        if (!response.ok) throw await this.errorFrom(response);

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        // SSE lines can be split across network chunks, so keep the
        // unfinished tail and only parse complete lines.
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    // Lines starting with ':' are keep-alive comments
                    // (": OPENROUTER PROCESSING") and are skipped here.
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') {
                        await callbacks.onComplete();
                        return;
                    }

                    let parsed: any;
                    try {
                        parsed = JSON.parse(data);
                    } catch {
                        continue;
                    }
                    // Errors after the stream starts arrive as a data frame.
                    if (parsed.error) {
                        throw new Error(`OpenRouter error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
                    }
                    const content = parsed.choices?.[0]?.delta?.content;
                    if (content) callbacks.onContent(content);
                }
            }
        } finally {
            reader.releaseLock();
        }

        await callbacks.onComplete();
    }
}
