import { StellaSettings } from '../types';
import { LLMProvider, ProviderContext, StreamCallbacks } from './types';

/**
 * OpenClaw WebSocket Provider
 * 
 * Connects directly to the OpenClaw Gateway WebSocket for full agent integration:
 * persistent sessions, native tools, memory, MCP servers — everything.
 * 
 * Protocol: OpenClaw Gateway WS (req/res/event frames)
 * - connect → hello-ok (handshake)
 * - chat.send → triggers agent run, streams via "chat" events
 * - chat.history → fetches session history
 * - chat.abort → stops current run
 * 
 * Chat event payload: { state, sessionKey, runId, message: { role, content } }
 * - state "delta": content is the FULL accumulated text so far (not a chunk)
 * - state "final": run complete, fetch history for final message
 * - state "error": run failed
 * - state "aborted": run was cancelled
 */

interface OpenClawFrame {
    type: 'req' | 'res' | 'event';
    id?: string;
    method?: string;
    params?: any;
    ok?: boolean;
    payload?: any;
    error?: any;
    event?: string;
    seq?: number;
}

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: Array<{ type: string; text?: string }> | string;
    timestamp?: number;
}

/**
 * Extract plain text from a chat event message.
 * Content can be a string or an array of { type: "text", text: "..." } parts.
 * Matches the Control UI's ni() function.
 */
function extractText(message: any): string | null {
    if (!message) return null;
    const content = message.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        const texts = content
            .filter((p: any) => p && p.type === 'text' && typeof p.text === 'string')
            .map((p: any) => p.text);
        return texts.length > 0 ? texts.join('') : null;
    }
    return null;
}

export class OpenClawProvider implements LLMProvider {
    name = 'openclaw';
    
    private ws: WebSocket | null = null;
    private connected = false;
    private connectNonce: string | null = null;
    private pendingRequests = new Map<string, {
        resolve: (value: any) => void;
        reject: (reason: any) => void;
    }>();
    private eventListeners = new Map<string, Array<(payload: any) => void>>();
    private requestCounter = 0;
    private sessionKey = 'agent:main:main';
    private gatewayUrl = '';
    private authToken = '';

    isConfigured(settings: StellaSettings): boolean {
        return !!settings.customApiUrl && !!settings.customApiKey;
    }

    private getWsUrl(settings: StellaSettings): string {
        let url = settings.customApiUrl.trim();
        url = url.replace(/\/v1\/?$/, '').replace(/\/$/, '');
        url = url.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
        if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
            url = 'ws://' + url;
        }
        return url;
    }

    private nextId(): string {
        return `stella-${++this.requestCounter}`;
    }

    private sendConnectFrame(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        
        const connectId = this.nextId();
        const connectFrame: OpenClawFrame = {
            type: 'req',
            id: connectId,
            method: 'connect',
            params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                    id: 'gateway-client',
                    displayName: 'Bulbasaur Chat (Obsidian)',
                    version: '0.2.0',
                    platform: navigator?.platform || 'linux',
                    mode: 'backend',
                },
                role: 'operator',
                scopes: ['operator.admin'],
                auth: {
                    token: this.authToken
                }
            }
        };

        // Store the pending connect request
        if (this._connectResolve) {
            this.pendingRequests.set(connectId, {
                resolve: this._connectResolve,
                reject: this._connectReject!
            });
        }

        this.ws.send(JSON.stringify(connectFrame));
    }

    private _connectResolve: ((value: any) => void) | null = null;
    private _connectReject: ((reason: any) => void) | null = null;

    private async connect(settings: StellaSettings): Promise<void> {
        if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
            return;
        }

        this.gatewayUrl = this.getWsUrl(settings);
        this.authToken = settings.customApiKey;

        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.gatewayUrl);
            } catch (err) {
                reject(new Error(`Failed to create WebSocket: ${err}`));
                return;
            }

            const connectTimeout = setTimeout(() => {
                reject(new Error('OpenClaw connection timeout (10s)'));
                this.ws?.close();
            }, 10000);

            this._connectResolve = (payload: any) => {
                clearTimeout(connectTimeout);
                this.connected = true;
                this._connectResolve = null;
                this._connectReject = null;
                console.log('OpenClaw: Connected to gateway');
                resolve();
            };

            this._connectReject = (err: any) => {
                clearTimeout(connectTimeout);
                this._connectResolve = null;
                this._connectReject = null;
                reject(new Error(`OpenClaw connect failed: ${JSON.stringify(err)}`));
            };

            this.ws.onopen = () => {
                this.sendConnectFrame();
            };

            this.ws.onmessage = (event) => {
                try {
                    const frame: OpenClawFrame = JSON.parse(String(event.data));
                    this.handleFrame(frame);
                } catch (err) {
                    console.error('OpenClaw: Failed to parse frame:', err);
                }
            };

            this.ws.onerror = () => {
                clearTimeout(connectTimeout);
                reject(new Error('OpenClaw WebSocket error'));
            };

            this.ws.onclose = (event) => {
                this.connected = false;
                for (const [, pending] of this.pendingRequests) {
                    pending.reject(new Error('Connection closed'));
                }
                this.pendingRequests.clear();
            };
        });
    }

    private handleFrame(frame: OpenClawFrame): void {
        // Handle connect.challenge (nonce-based handshake)
        if (frame.type === 'event' && frame.event === 'connect.challenge') {
            const nonce = frame.payload?.nonce;
            if (typeof nonce === 'string') {
                this.connectNonce = nonce;
                this.sendConnectFrame();
            }
            return;
        }

        if (frame.type === 'res') {
            if (!frame.ok) {
                console.error('OpenClaw error:', frame.error);
            }
            const pending = this.pendingRequests.get(frame.id!);
            if (pending) {
                this.pendingRequests.delete(frame.id!);
                if (frame.ok) {
                    pending.resolve(frame.payload);
                } else {
                    pending.reject(frame.error || 'Unknown error');
                }
            }
        } else if (frame.type === 'event') {
            const listeners = this.eventListeners.get(frame.event!) || [];
            for (const listener of listeners) {
                listener(frame.payload);
            }
        }
    }

    private async request(method: string, params: any = {}): Promise<any> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('Not connected to OpenClaw');
        }

        const id = this.nextId();
        const frame: OpenClawFrame = { type: 'req', id, method, params };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Request ${method} timed out (300s)`));
            }, 300000);

            this.pendingRequests.set(id, {
                resolve: (payload) => { clearTimeout(timeout); resolve(payload); },
                reject: (err) => { clearTimeout(timeout); reject(err); }
            });

            this.ws!.send(JSON.stringify(frame));
        });
    }

    private on(event: string, listener: (payload: any) => void): void {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, []);
        }
        this.eventListeners.get(event)!.push(listener);
    }

    private off(event: string, listener: (payload: any) => void): void {
        const listeners = this.eventListeners.get(event);
        if (listeners) {
            const idx = listeners.indexOf(listener);
            if (idx >= 0) listeners.splice(idx, 1);
        }
    }

    private generateIdempotencyKey(): string {
        const array = new Uint8Array(16);
        crypto.getRandomValues(array);
        return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
    }

    async call(context: ProviderContext): Promise<string> {
        let fullResponse = '';
        await this.stream(context, {
            onContent: (text) => { fullResponse += text; },
            onComplete: async () => {}
        });
        return fullResponse;
    }

    async stream(context: ProviderContext, callbacks: StreamCallbacks): Promise<void> {
        const { settings, messages } = context;

        await this.connect(settings);

        const lastMessage = messages[messages.length - 1];
        if (!lastMessage || lastMessage.role !== 'user') {
            throw new Error('No user message to send');
        }

        const idempotencyKey = this.generateIdempotencyKey();
        
        // Use a promise that resolves when the run completes
        // instead of polling — much faster and cleaner
        let streamedText = '';

        const runDone = new Promise<void>((resolveRun) => {
            const chatListener = (payload: any) => {
                if (!payload) return;
                if (payload.sessionKey && payload.sessionKey !== this.sessionKey) return;

                if (payload.state === 'delta') {
                    // payload.message contains the FULL accumulated message so far
                    const fullText = extractText(payload.message);
                    if (fullText !== null && fullText.length > streamedText.length) {
                        const delta = fullText.slice(streamedText.length);
                        streamedText = fullText;
                        callbacks.onContent(delta);
                    }
                } else if (payload.state === 'final') {
                    // On final, do one last text extraction to catch anything missed
                    const finalText = extractText(payload.message);
                    if (finalText !== null && finalText.length > streamedText.length) {
                        const delta = finalText.slice(streamedText.length);
                        streamedText = finalText;
                        callbacks.onContent(delta);
                    }
                    cleanup();
                    resolveRun();
                } else if (payload.state === 'aborted' || payload.state === 'error') {
                    if (payload.state === 'error' && payload.errorMessage) {
                        callbacks.onContent(`\n\nError: ${payload.errorMessage}`);
                    }
                    cleanup();
                    resolveRun();
                }
            };

            const cleanup = () => {
                this.off('chat', chatListener);
            };

            this.on('chat', chatListener);

            // Safety timeout — if we never get a final event
            setTimeout(() => {
                cleanup();
                resolveRun();
            }, 300000); // 5 minutes
        });

        // /stop: ask the gateway to cancel the run; it answers with an
        // "aborted" chat event, which resolves runDone above.
        const onAbort = () => { this.abort(settings).catch(() => {}); };
        context.signal?.addEventListener('abort', onAbort, { once: true });

        try {
            // Send the message
            await this.request('chat.send', {
                sessionKey: this.sessionKey,
                message: lastMessage.content,
                deliver: false,
                idempotencyKey
            });

            // Wait for the run to complete (resolved by chat event listener)
            await runDone;
        } finally {
            context.signal?.removeEventListener('abort', onAbort);
        }
        await callbacks.onComplete();
    }

    /**
     * Fetch chat history from the gateway session
     */
    async getHistory(settings: StellaSettings): Promise<ChatMessage[]> {
        await this.connect(settings);
        const result = await this.request('chat.history', {
            sessionKey: this.sessionKey,
            limit: 200
        });
        return result.messages || [];
    }

    /**
     * Abort the current agent run
     */
    async abort(settings: StellaSettings): Promise<void> {
        if (!this.connected) return;
        await this.request('chat.abort', {
            sessionKey: this.sessionKey
        });
    }

    /**
     * Disconnect from the gateway
     */
    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        this.pendingRequests.clear();
        this.eventListeners.clear();
    }
}
