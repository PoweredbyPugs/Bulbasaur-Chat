import { StellaSettings } from '../types';
import { LLMProviderWithMCP, ProviderContext, StreamCallbacks, MCPContext, ProviderMessage } from './types';

interface GoogleContent {
    role: string;
    parts: Array<{ text?: string; functionResponse?: any }>;
}

export class GoogleProvider implements LLMProviderWithMCP {
    name = 'google';

    isConfigured(settings: StellaSettings): boolean {
        return !!settings.googleApiKey;
    }

    // Convert standard messages to Google format
    private toGoogleContents(messages: ProviderMessage[]): GoogleContent[] {
        const contents: GoogleContent[] = [];

        for (const msg of messages) {
            if (msg.role === 'system') continue; // System is handled separately
            contents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.content }]
            });
        }

        return contents;
    }

    // Build function declarations from MCP servers
    private buildFunctionDeclarations(mcpContext: MCPContext): any[] {
        const functionDeclarations: any[] = [];

        for (const server of mcpContext.servers) {
            for (const tool of server.tools) {
                let cleanedSchema = tool.inputSchema || {
                    type: "object",
                    properties: {},
                    required: []
                };

                // Remove fields that Google API doesn't accept
                if (cleanedSchema && typeof cleanedSchema === 'object') {
                    const { $schema, additionalProperties, ...googleCompatibleSchema } = cleanedSchema;
                    cleanedSchema = googleCompatibleSchema;
                }

                functionDeclarations.push({
                    name: `${server.name}_${tool.name}`,
                    description: tool.description || `Execute ${tool.name} from ${server.name}`,
                    parameters: cleanedSchema
                });
            }
        }

        return functionDeclarations;
    }

    async call(context: ProviderContext): Promise<string> {
        return this.callWithMCP(context, { servers: [], executeTool: async () => null });
    }

    async callWithMCP(context: ProviderContext, mcpContext: MCPContext, retryCount = 0): Promise<string> {
        const { settings, messages, systemMessage } = context;

        if (!settings.googleApiKey) {
            throw new Error('Please set your Google API key in settings');
        }

        const contents = this.toGoogleContents(messages);

        const requestBody: any = {
            contents: contents,
            generationConfig: {
                temperature: settings.temperature,
                maxOutputTokens: settings.maxTokens
            }
        };

        if (systemMessage) {
            requestBody.systemInstruction = { parts: [{ text: systemMessage }] };
        }

        // Add MCP tools if available
        const functionDeclarations = this.buildFunctionDeclarations(mcpContext);
        if (functionDeclarations.length > 0) {
            requestBody.tools = [{ functionDeclarations }];
        }

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent?key=${settings.googleApiKey}`,
            {
                method: 'POST',
                signal: context.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 503 && retryCount < 2) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
                return this.callWithMCP(context, mcpContext, retryCount + 1);
            }
            throw new Error(`Google API error (${response.status}): ${response.statusText}. ${errorText}`);
        }

        const data = await response.json();
        const candidate = data?.candidates?.[0];

        if (!candidate) {
            throw new Error('No candidate in Google API response');
        }

        // Handle function calls
        const functionCall = candidate.content?.parts?.find((part: any) => part.functionCall);

        if (functionCall?.functionCall && mcpContext.executeTool) {
            const { name, args } = functionCall.functionCall;

            if (!name) {
                throw new Error('Function call missing name');
            }

            try {
                const result = await mcpContext.executeTool(name, args || {});

                // Follow-up call with function result
                const followUpContents = [...contents, {
                    role: 'function',
                    parts: [{
                        functionResponse: { name, response: result }
                    }]
                }];

                const followUpResponse = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent?key=${settings.googleApiKey}`,
                    {
                        method: 'POST',
                        signal: context.signal,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...requestBody, contents: followUpContents })
                    }
                );

                if (followUpResponse.ok) {
                    const followUpData = await followUpResponse.json();
                    return followUpData.candidates[0].content.parts[0].text;
                }
            } catch (error: any) {
                return `Error executing tool ${name}: ${error.message}`;
            }
        }

        return candidate.content.parts[0].text;
    }

    async stream(context: ProviderContext, callbacks: StreamCallbacks): Promise<void> {
        return this.streamWithMCP(context, callbacks, { servers: [], executeTool: async () => null });
    }

    async streamWithMCP(
        context: ProviderContext,
        callbacks: StreamCallbacks,
        mcpContext: MCPContext
    ): Promise<void> {
        const { settings, messages, systemMessage } = context;

        if (!settings.googleApiKey) {
            throw new Error('Please set your Google API key in settings');
        }

        const contents = this.toGoogleContents(messages);

        const requestBody: any = {
            contents: contents,
            generationConfig: {
                temperature: settings.temperature,
                maxOutputTokens: settings.maxTokens
            }
        };

        if (systemMessage) {
            requestBody.systemInstruction = { parts: [{ text: systemMessage }] };
        }

        // Add MCP tools if available
        const functionDeclarations = this.buildFunctionDeclarations(mcpContext);
        if (functionDeclarations.length > 0) {
            requestBody.tools = [{ functionDeclarations }];
        }

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:streamGenerateContent?key=${settings.googleApiKey}`,
            {
                method: 'POST',
                signal: context.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            }
        );

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Google API error: ${error}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                buffer += chunk;

                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.trim() === '') continue;

                    try {
                        let jsonLine = line.trim();
                        if (jsonLine.startsWith('data: ')) {
                            jsonLine = jsonLine.slice(6).trim();
                        }

                        if (jsonLine === '[' || jsonLine === ']' || jsonLine === '') continue;
                        if (jsonLine.endsWith(',')) jsonLine = jsonLine.slice(0, -1);

                        const parsed = JSON.parse(jsonLine);
                        const candidates = Array.isArray(parsed) ? parsed : [parsed];

                        for (const item of candidates) {
                            // Handle function calls
                            const functionCall = item.candidates?.[0]?.content?.parts?.[0]?.functionCall;
                            if (functionCall && mcpContext.executeTool) {
                                const { name, args } = functionCall;
                                if (name) {
                                    try {
                                        await mcpContext.executeTool(name, args || {});
                                    } catch (error) {
                                        console.error('MCP tool execution error:', error);
                                    }
                                }
                            }

                            const content = item.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (content) {
                                callbacks.onContent(content);
                            }
                        }
                    } catch (e) {
                        // Continue on parse errors
                    }
                }
            }

            // Process remaining buffer
            if (buffer.trim()) {
                try {
                    const parsed = JSON.parse(buffer);
                    const content = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (content) {
                        callbacks.onContent(content);
                    }
                } catch (e) {
                    // Ignore
                }
            }
        } finally {
            reader.releaseLock();
        }

        await callbacks.onComplete();
    }
}
