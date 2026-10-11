// Enhanced Fetch with Compression Support
export class FetchManager {
    static async enhancedFetch(url: string, options: RequestInit = {}): Promise<Response> {
        const headers = new Headers(options.headers);

        // Add compression support headers
        headers.set('Accept-Encoding', 'gzip, deflate, br');

        // Enhance existing headers if needed
        if (!headers.has('Content-Type') && options.method === 'POST') {
            headers.set('Content-Type', 'application/json');
        }

        // User agent for better API compatibility
        headers.set('User-Agent', 'Bulbasaur-Chat-Obsidian-Plugin/1.0');

        const enhancedOptions: RequestInit = {
            ...options,
            headers: headers
        };

        return await fetch(url, enhancedOptions);
    }
}
