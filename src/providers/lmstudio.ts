import { StellaSettings } from '../types';
import { LLMProvider, ProviderContext, StreamCallbacks } from './types';

export class LMStudioProvider implements LLMProvider {
    name = 'lmstudio';

    isConfigured(settings: StellaSettings): boolean {
        return !!settings.lmStudioBaseUrl;
    }

    async call(context: ProviderContext): Promise<string> {
        const { settings, messages } = context;

        const response = await fetch(`${settings.lmStudioBaseUrl}/v1/chat/completions`, {
            method: 'POST',
            signal: context.signal,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: settings.model,
                messages: messages,
                max_tokens: settings.maxTokens,
                temperature: settings.temperature
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`LM Studio API error: ${error}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    }

    async stream(context: ProviderContext, callbacks: StreamCallbacks): Promise<void> {
        const { settings, messages } = context;

        const response = await fetch(`${settings.lmStudioBaseUrl}/v1/chat/completions`, {
            method: 'POST',
            signal: context.signal,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: settings.model,
                messages: messages,
                max_tokens: settings.maxTokens,
                temperature: settings.temperature,
                stream: true
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`LM Studio API error: ${error}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');

                // Keep the last incomplete line in the buffer
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('data: ')) {
                        const data = trimmed.slice(6);
                        if (data === '[DONE]') {
                            await callbacks.onComplete();
                            return;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            const content = parsed.choices?.[0]?.delta?.content;
                            if (content) {
                                callbacks.onContent(content);
                            }
                        } catch (e) {
                            // Skip malformed JSON
                        }
                    }
                }
            }

            // Process any remaining data in buffer
            if (buffer.trim().startsWith('data: ')) {
                const data = buffer.trim().slice(6);
                if (data !== '[DONE]') {
                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices?.[0]?.delta?.content;
                        if (content) {
                            callbacks.onContent(content);
                        }
                    } catch (e) {
                        // Skip malformed JSON
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        await callbacks.onComplete();
    }
}
