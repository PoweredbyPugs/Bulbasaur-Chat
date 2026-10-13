import { StellaSettings } from '../types';
import { LLMProvider, ProviderContext, StreamCallbacks } from './types';

export class OpenAIProvider implements LLMProvider {
    name = 'openai';

    isConfigured(settings: StellaSettings): boolean {
        return !!settings.openaiApiKey;
    }

    async call(context: ProviderContext): Promise<string> {
        const { settings, messages } = context;

        if (!settings.openaiApiKey) {
            throw new Error('Please set your OpenAI API key in settings');
        }

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            signal: context.signal,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.openaiApiKey}`
            },
            body: JSON.stringify({
                model: settings.model,
                messages: messages,
                max_tokens: settings.maxTokens,
                temperature: settings.temperature
            })
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.statusText}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    }

    async stream(context: ProviderContext, callbacks: StreamCallbacks): Promise<void> {
        const { settings, messages } = context;

        if (!settings.openaiApiKey) {
            throw new Error('Please set your OpenAI API key in settings');
        }

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            signal: context.signal,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.openaiApiKey}`
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
            throw new Error(`OpenAI API error: ${error}`);
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
        } finally {
            reader.releaseLock();
        }

        await callbacks.onComplete();
    }
}
