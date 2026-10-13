import { StellaSettings } from '../types';

// Message format for provider APIs
export interface ProviderMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

// Context passed to providers
export interface ProviderContext {
    settings: StellaSettings;
    messages: ProviderMessage[];
    systemMessage: string | null;
    // Aborted by /stop; providers hand it to fetch or cancel their own run
    signal?: AbortSignal;
}

// Streaming callbacks
export interface StreamCallbacks {
    onContent: (text: string) => void;
    onComplete: () => Promise<void>;
}

// MCP context for providers that support tool calling
export interface MCPContext {
    servers: MCPServerInfo[];
    executeTool: (functionName: string, args: any) => Promise<any>;
}

export interface MCPServerInfo {
    name: string;
    tools: Array<{
        name: string;
        description: string;
        inputSchema: any;
    }>;
}

// Provider interface
export interface LLMProvider {
    name: string;

    // Check if provider is configured
    isConfigured(settings: StellaSettings): boolean;

    // Non-streaming call
    call(context: ProviderContext): Promise<string>;

    // Streaming call
    stream(context: ProviderContext, callbacks: StreamCallbacks): Promise<void>;
}

// Provider with MCP support
export interface LLMProviderWithMCP extends LLMProvider {
    // Non-streaming call with MCP
    callWithMCP(context: ProviderContext, mcpContext: MCPContext): Promise<string>;

    // Streaming call with MCP
    streamWithMCP(context: ProviderContext, callbacks: StreamCallbacks, mcpContext: MCPContext): Promise<void>;
}

// Helper to build messages array from chat history
export function buildMessagesArray(
    chatHistory: Array<{ role: string; content: string }>,
    currentMessage: string,
    systemMessage: string | null
): ProviderMessage[] {
    const messages: ProviderMessage[] = [];

    if (systemMessage) {
        messages.push({ role: 'system', content: systemMessage });
    }

    chatHistory.forEach(msg => {
        messages.push({
            role: msg.role as 'user' | 'assistant',
            content: msg.content
        });
    });

    messages.push({ role: 'user', content: currentMessage });

    return messages;
}
