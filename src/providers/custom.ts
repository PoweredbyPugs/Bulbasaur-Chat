import { StellaSettings } from '../types';
import { LLMProvider, ProviderContext, StreamCallbacks } from './types';

export class CustomAPIProvider implements LLMProvider {
    name = 'custom';

    isConfigured(settings: StellaSettings): boolean {
        return !!settings.customApiUrl;
    }

    async call(context: ProviderContext): Promise<string> {
        const { settings, messages } = context;

        if (!settings.customApiUrl) {
            throw new Error('Please set your custom API URL in settings');
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (settings.customApiKey) {
            headers['Authorization'] = `Bearer ${settings.customApiKey}`;
        }

        const response = await fetch(settings.customApiUrl, {
            method: 'POST',
            signal: context.signal,
            headers: headers,
            body: JSON.stringify({
                model: settings.model,
                messages: messages,
                max_tokens: settings.maxTokens,
                temperature: settings.temperature
            })
        });

        if (!response.ok) {
            throw new Error(`Custom API error: ${response.statusText}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
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
