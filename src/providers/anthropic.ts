import { StellaSettings } from '../types';
import { LLMProvider, ProviderContext, StreamCallbacks, ProviderMessage } from './types';

export class AnthropicProvider implements LLMProvider {
    name = 'anthropic';

    isConfigured(settings: StellaSettings): boolean {
        return !!settings.anthropicApiKey;
    }

    // Anthropic doesn't include system in messages array - filter it out
    private filterSystemMessages(messages: ProviderMessage[]): ProviderMessage[] {
        return messages.filter(m => m.role !== 'system');
    }

    async call(context: ProviderContext): Promise<string> {
        const { settings, messages, systemMessage } = context;

        if (!settings.anthropicApiKey) {
            throw new Error('Please set your Anthropic API key in settings');
        }

        const requestBody: any = {
            model: settings.model,
            max_tokens: settings.maxTokens,
            temperature: settings.temperature,
            messages: this.filterSystemMessages(messages)
        };

        // Anthropic uses separate system parameter
        if (systemMessage) {
            requestBody.system = systemMessage;
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            signal: context.signal,
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': settings.anthropicApiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            throw new Error(`Anthropic API error: ${response.statusText}`);
        }

        const data = await response.json();
        return data.content[0].text;
    }

    async stream(context: ProviderContext, callbacks: StreamCallbacks): Promise<void> {
        const { settings, messages, systemMessage } = context;

        if (!settings.anthropicApiKey) {
            throw new Error('Please set your Anthropic API key in settings');
        }

        const requestBody: any = {
            model: settings.model,
            max_tokens: settings.maxTokens,
            temperature: settings.temperature,
            messages: this.filterSystemMessages(messages),
            stream: true
        };

        if (systemMessage) {
            requestBody.system = systemMessage;
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            signal: context.signal,
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': settings.anthropicApiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Anthropic API error: ${error}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') {
                            await callbacks.onComplete();
                            return;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.type === 'content_block_delta') {
                                const content = parsed.delta?.text;
                                if (content) {
                                    callbacks.onContent(content);
                                }
                            }
                        } catch (e) {
                            // Skip malformed JSON
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        await callbacks.onComplete();
    }
}
