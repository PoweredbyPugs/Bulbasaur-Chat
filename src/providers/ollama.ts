import { StellaSettings } from '../types';
import { LLMProvider, ProviderContext, StreamCallbacks, ProviderMessage } from './types';

export class OllamaProvider implements LLMProvider {
    name = 'ollama';

    isConfigured(settings: StellaSettings): boolean {
        return !!settings.ollamaBaseUrl;
    }

    // Ollama uses a different prompt format
    private buildPrompt(messages: ProviderMessage[], systemMessage: string | null): string {
        let prompt = '';

        if (systemMessage) {
            prompt += systemMessage + '\n\n';
        }

        for (const msg of messages) {
            if (msg.role === 'system') continue;
            const role = msg.role === 'user' ? 'User' : 'Assistant';
            prompt += `${role}: ${msg.content}\n`;
        }

        prompt += 'Assistant:';
        return prompt;
    }

    async call(context: ProviderContext): Promise<string> {
        const { settings, messages, systemMessage } = context;

        const prompt = this.buildPrompt(messages, systemMessage);

        const response = await fetch(`${settings.ollamaBaseUrl}/api/generate`, {
            method: 'POST',
            signal: context.signal,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: settings.model,
                prompt: prompt,
                stream: false,
                options: {
                    temperature: settings.temperature,
                    num_predict: settings.maxTokens
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.statusText}`);
        }

        const data = await response.json();
        return data.response;
    }

    async stream(context: ProviderContext, callbacks: StreamCallbacks): Promise<void> {
        // Fallback: simulate streaming from regular call
        const response = await this.call(context);
        const words = response.split(' ');

        for (let i = 0; i < words.length; i++) {
            const chunk = i === 0 ? words[i] : ' ' + words[i];
            callbacks.onContent(chunk);
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        await callbacks.onComplete();
    }
}
