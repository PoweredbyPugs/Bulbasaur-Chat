import { AsyncLogger } from '../logger';
import { MCPServer, MCPTool, MCPResource, MCPPrompt, MCPMessage } from '../../types';

// MCP (Model Context Protocol) Client Manager
export class MCPClientManager {
    private servers: Map<string, MCPServer> = new Map();
    private connections: Map<string, WebSocket | any> = new Map();
    private tools: Map<string, MCPTool[]> = new Map();
    private resources: Map<string, MCPResource[]> = new Map();
    private prompts: Map<string, MCPPrompt[]> = new Map();
    private messageId = 0;
    private logger: AsyncLogger;
    private pendingRequests: Map<string | number, (response: MCPMessage) => void> = new Map();

    constructor(logger: AsyncLogger) {
        this.logger = logger;
    }

    // Getters for accessing private properties
    getServers(): Map<string, MCPServer> {
        return this.servers;
    }

    getTools(): Map<string, MCPTool[]> {
        return this.tools;
    }

    getPrompts(): Map<string, MCPPrompt[]> {
        return this.prompts;
    }

    getResources(): Map<string, MCPResource[]> {
        return this.resources;
    }

    // Public methods to force refresh tools and prompts
    async refreshServerTools(serverId: string): Promise<void> {
        const server = this.servers.get(serverId);
        console.log(`MCP Debug - refreshServerTools called for ${serverId}, server exists: ${!!server}, connected: ${server?.connected}`);
        if (server && server.connected) {
            console.log(`MCP Debug - Discovering tools for server ${serverId}...`);
            await this.discoverTools(serverId);
            const tools = this.tools.get(serverId) || [];
            console.log(`MCP Debug - After discovery, server ${serverId} has ${tools.length} tools:`, tools.map(t => t.name));
        }
    }

    async refreshServerPrompts(serverId: string): Promise<void> {
        const server = this.servers.get(serverId);
        console.log(`MCP Debug - refreshServerPrompts called for ${serverId}, server exists: ${!!server}, connected: ${server?.connected}`);
        if (server && server.connected) {
            console.log(`MCP Debug - Discovering prompts for server ${serverId}...`);
            await this.discoverPrompts(serverId);
            const prompts = this.prompts.get(serverId) || [];
            console.log(`MCP Debug - After discovery, server ${serverId} has ${prompts.length} prompts:`, prompts.map(p => p.name));
        }
    }

    // Server Management
    async addServer(server: MCPServer): Promise<boolean> {
        this.logger.log(`Adding MCP server: ${server.name}`);
        this.servers.set(server.id, server);
        return this.connectToServer(server.id);
    }

    async removeServer(serverId: string): Promise<void> {
        this.logger.log(`Removing MCP server: ${serverId}`);
        await this.disconnectFromServer(serverId);
        this.servers.delete(serverId);
        this.tools.delete(serverId);
        this.resources.delete(serverId);
        this.prompts.delete(serverId);
    }

    async connectToServer(serverId: string): Promise<boolean> {
        const server = this.servers.get(serverId);
        if (!server) {
            this.logger.error(`Server not found: ${serverId}`);
            return false;
        }

        try {
            if (server.transport === 'http') {
                return await this.connectHTTP(server);
            } else if (server.transport === 'stdio') {
                return await this.connectStdio(server);
            }
        } catch (error) {
            this.logger.error(`Failed to connect to server ${serverId}:`, error);
            server.connected = false;
            return false;
        }
        return false;
    }

    private async connectHTTP(server: MCPServer): Promise<boolean> {
        if (!server.endpoint) {
            this.logger.error(`HTTP server ${server.id} missing endpoint`);
            return false;
        }

        try {
            // Pasted endpoints often arrive wrapped in quotes; tolerate that.
            server.endpoint = String(server.endpoint).trim().replace(/^["']+|["']+$/g, '');
            const ws = new WebSocket(server.endpoint);

            ws.onmessage = (event) => {
                this.handleMessage(server.id, JSON.parse(event.data));
            };

            ws.onclose = () => {
                this.logger.log(`Disconnected from MCP server: ${server.name}`);
                server.connected = false;
            };

            // Wait for the socket to actually open (or fail) before reporting connected,
            // mirroring connectStdio, so tool discovery has finished when we return.
            await new Promise<void>((resolve, reject) => {
                ws.onopen = () => resolve();
                ws.onerror = (error) => {
                    this.logger.error(`WebSocket error for server ${server.name}:`, error);
                    reject(new Error(`WebSocket connection failed for ${server.name}`));
                };
            });

            ws.onerror = (error) => {
                this.logger.error(`WebSocket error for server ${server.name}:`, error);
                server.connected = false;
            };

            this.connections.set(server.id, ws);
            server.connected = true;
            this.logger.log(`Connected to MCP server: ${server.name}`);
            await this.initializeServerCapabilities(server.id);
            return true;
        } catch (error) {
            this.logger.error(`HTTP connection failed for server ${server.id}:`, error);
            server.connected = false;
            return false;
        }
    }

    /**
     * Fix command for Windows compatibility
     */
    private fixWindowsCommand(command: string): string {
        if (process.platform !== 'win32') {
            return command;
        }

        const windowsCommands = ['npm', 'npx', 'yarn', 'pnpm', 'node'];
        const baseCommand = command.split(' ')[0];
        if (windowsCommands.includes(baseCommand) && !baseCommand.endsWith('.cmd')) {
            return command.replace(baseCommand, `${baseCommand}.cmd`);
        }

        return command;
    }

    private async connectStdio(server: MCPServer): Promise<boolean> {
        if (!server.command) {
            this.logger.error(`STDIO server ${server.id} missing command`);
            return false;
        }

        try {
            const { spawn } = require('child_process');

            const args = server.args || [];
            const env = {
                ...process.env,
                ...(server.env || {})
            };

            const command = this.fixWindowsCommand(server.command);

            this.logger.log(`Starting STDIO MCP server: ${command} ${args.join(' ')}`);

            const spawnOptions: any = {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: env
            };

            if (process.platform === 'win32' && command.endsWith('.cmd')) {
                spawnOptions.shell = true;
            }

            const childProcess = spawn(command, args, spawnOptions);

            childProcess.on('error', (error: Error) => {
                this.logger.error(`STDIO server ${server.name} process error:`, error);
                server.connected = false;
            });

            childProcess.on('exit', (code: number, signal: string) => {
                this.logger.log(`STDIO server ${server.name} exited with code ${code}, signal ${signal}`);
                server.connected = false;
            });

            childProcess.stderr.on('data', (data: Buffer) => {
                this.logger.warn(`STDIO server ${server.name} stderr: ${data.toString()}`);
            });

            let buffer = '';
            childProcess.stdout.on('data', (data: Buffer) => {
                buffer += data.toString();

                let lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const message = JSON.parse(line.trim());
                            this.handleMessage(server.id, message);
                        } catch (error) {
                            this.logger.error(`Failed to parse JSON from ${server.name}:`, error);
                            this.logger.error(`Raw line: ${line}`);
                        }
                    }
                }
            });

            this.connections.set(server.id, childProcess);
            server.connected = true;
            this.logger.log(`Connected to STDIO MCP server: ${server.name}`);

            await this.initializeServerCapabilities(server.id);

            return true;
        } catch (error) {
            this.logger.error(`STDIO connection failed for server ${server.id}:`, error);
            return false;
        }
    }

    private async disconnectFromServer(serverId: string): Promise<void> {
        const connection = this.connections.get(serverId);
        if (connection) {
            if (connection instanceof WebSocket) {
                connection.close();
            } else if (connection && connection.kill) {
                connection.kill('SIGTERM');
            }
            this.connections.delete(serverId);
        }

        const server = this.servers.get(serverId);
        if (server) {
            server.connected = false;
        }
    }

    // Protocol Message Handling
    private async sendMessage(serverId: string, message: MCPMessage): Promise<any> {
        try {
            console.log(`MCP sendMessage: Sending to server ${serverId}:`, message);

            const connection = this.connections.get(serverId);
            if (!connection) {
                throw new Error(`No connection to server: ${serverId}`);
            }

            if (message.method) {
                message.id = ++this.messageId;
                console.log(`MCP sendMessage: Added message ID: ${message.id}`);
            }

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    if (this.pendingRequests && this.pendingRequests.has(message.id!)) {
                        this.pendingRequests.delete(message.id!);
                    }
                    reject(new Error('MCP request timeout'));
                }, 30000); // 30 second timeout for slower MCP servers

                const responseHandler = (response: MCPMessage) => {
                    try {
                        console.log(`MCP sendMessage: Got response for message ${message.id}:`, response);
                        clearTimeout(timeout);
                        if (this.pendingRequests && this.pendingRequests.has(message.id!)) {
                            this.pendingRequests.delete(message.id!);
                        }
                        if (response && response.error) {
                            reject(new Error(`MCP Error: ${response.error.message}`));
                        } else {
                            resolve(response ? response.result : null);
                        }
                    } catch (handlerError) {
                        console.error('MCP sendMessage: Error in response handler:', handlerError);
                        reject(handlerError);
                    }
                };

                if (!this.pendingRequests) {
                    this.pendingRequests = new Map();
                }
                this.pendingRequests.set(message.id!, responseHandler);

                if (connection instanceof WebSocket) {
                    connection.send(JSON.stringify(message));
                } else if (connection && connection.stdin) {
                    connection.stdin.write(JSON.stringify(message) + '\n');
                }
            });
        } catch (sendError) {
            console.error('MCP sendMessage: Error in sendMessage:', sendError);
            throw sendError;
        }
    }

    private handleMessage(serverId: string, message: MCPMessage): void {
        try {
            this.logger.log(`Received MCP message from ${serverId}:`, message);

            if (!message) {
                console.warn(`Received null/undefined message from server ${serverId}`);
                return;
            }

            if (message.method) {
                this.handleServerRequest(serverId, message);
            } else if (message.result !== undefined || message.error !== undefined) {
                this.handleServerResponse(serverId, message);
            } else {
                console.log(`Unknown message type from server ${serverId}:`, message);
            }
        } catch (error) {
            console.error(`Error handling message from server ${serverId}:`, error, message);
        }
    }

    private handleServerRequest(serverId: string, message: MCPMessage): void {
        this.logger.log(`Server ${serverId} sent request: ${message.method}`);
    }

    private handleServerResponse(serverId: string, message: MCPMessage): void {
        try {
            const messageId = message?.id;
            this.logger.log(`Server ${serverId} sent response to request ${messageId || 'unknown'}`);

            if (messageId && this.pendingRequests && this.pendingRequests.has(messageId)) {
                const responseHandler = this.pendingRequests.get(messageId);
                if (responseHandler && typeof responseHandler === 'function') {
                    responseHandler(message);
                }
                this.pendingRequests.delete(messageId);
            } else {
                console.log(`No pending request handler found for message ID: ${messageId}`);
            }
        } catch (error) {
            console.error(`Error handling server response from ${serverId}:`, error, message);
        }
    }

    // Server Initialization
    private async initializeServerCapabilities(serverId: string): Promise<void> {
        try {
            await this.sendMessage(serverId, {
                jsonrpc: '2.0',
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                        roots: { listChanged: true },
                        sampling: {}
                    },
                    clientInfo: {
                        name: 'stella-obsidian-plugin',
                        version: '1.0.0'
                    }
                }
            });

            await this.discoverTools(serverId);
            await this.discoverResources(serverId);
            await this.discoverPrompts(serverId);
        } catch (error) {
            this.logger.error(`Failed to initialize server ${serverId}:`, error);
        }
    }

    // Tool Discovery and Execution
    private async discoverTools(serverId: string): Promise<void> {
        try {
            console.log(`MCP Debug - Discovering tools for server ${serverId}`);
            const result = await this.sendMessage(serverId, {
                jsonrpc: '2.0',
                method: 'tools/list'
            });

            console.log(`MCP Debug - Tools/list result for ${serverId}:`, result);

            if (result?.tools) {
                const tools: MCPTool[] = result.tools.map((tool: any) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                    serverId
                }));

                console.log(`MCP Debug - Mapped ${tools.length} tools for server ${serverId}:`, tools.map(t => t.name));
                this.tools.set(serverId, tools);
                this.logger.log(`Discovered ${tools.length} tools for server ${serverId}`);
            }
        } catch (error) {
            this.logger.error(`Failed to discover tools for server ${serverId}:`, error);
        }
    }

    async executeTool(serverId: string, toolName: string, arguments_: any): Promise<any> {
        try {
            console.log(`MCP executeTool: Starting execution of ${toolName} on server ${serverId}`);
            console.log(`MCP executeTool: Arguments:`, arguments_);

            const safeArguments = arguments_ || {};

            const result = await this.sendMessage(serverId, {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: toolName,
                    arguments: safeArguments
                }
            });

            console.log(`MCP executeTool: Got result for ${toolName}:`, result);
            this.logger.log(`Executed tool ${toolName} on server ${serverId}`);
            return result;
        } catch (error) {
            console.error(`MCP executeTool: Failed to execute tool ${toolName} on server ${serverId}:`, error);
            this.logger.error(`Failed to execute tool ${toolName} on server ${serverId}:`, error);
            throw error;
        }
    }

    // Resource Discovery and Access
    private async discoverResources(serverId: string): Promise<void> {
        try {
            const result = await this.sendMessage(serverId, {
                jsonrpc: '2.0',
                method: 'resources/list'
            });

            if (result?.resources) {
                const resources: MCPResource[] = result.resources.map((resource: any) => ({
                    uri: resource.uri,
                    name: resource.name,
                    description: resource.description,
                    mimeType: resource.mimeType,
                    serverId
                }));

                this.resources.set(serverId, resources);
                this.logger.log(`Discovered ${resources.length} resources for server ${serverId}`);
            }
        } catch (error) {
            this.logger.error(`Failed to discover resources for server ${serverId}:`, error);
        }
    }

    async getResource(serverId: string, uri: string): Promise<any> {
        try {
            const result = await this.sendMessage(serverId, {
                jsonrpc: '2.0',
                method: 'resources/read',
                params: { uri }
            });

            this.logger.log(`Retrieved resource ${uri} from server ${serverId}`);
            return result;
        } catch (error) {
            this.logger.error(`Failed to get resource ${uri} from server ${serverId}:`, error);
            throw error;
        }
    }

    // Prompt Discovery and Usage
    private async discoverPrompts(serverId: string): Promise<void> {
        try {
            console.log(`MCP Debug - Discovering prompts for server ${serverId}`);
            const result = await this.sendMessage(serverId, {
                jsonrpc: '2.0',
                method: 'prompts/list'
            });

            console.log(`MCP Debug - Prompts/list result for ${serverId}:`, result);

            if (result?.prompts) {
                const prompts: MCPPrompt[] = result.prompts.map((prompt: any) => ({
                    name: prompt.name,
                    description: prompt.description,
                    arguments: prompt.arguments,
                    serverId
                }));

                console.log(`MCP Debug - Mapped ${prompts.length} prompts for server ${serverId}:`, prompts.map(p => p.name));
                this.prompts.set(serverId, prompts);
                this.logger.log(`Discovered ${prompts.length} prompts for server ${serverId}`);
            }
        } catch (error) {
            this.logger.error(`Failed to discover prompts for server ${serverId}:`, error);
        }
    }

    async getPrompt(serverId: string, promptName: string, arguments_?: any): Promise<any> {
        try {
            const result = await this.sendMessage(serverId, {
                jsonrpc: '2.0',
                method: 'prompts/get',
                params: {
                    name: promptName,
                    arguments: arguments_
                }
            });

            this.logger.log(`Retrieved prompt ${promptName} from server ${serverId}`);
            return result;
        } catch (error) {
            this.logger.error(`Failed to get prompt ${promptName} from server ${serverId}:`, error);
            throw error;
        }
    }

    // Public API for UI
    getConnectedServers(): MCPServer[] {
        return Array.from(this.servers.values()).filter(server => server.connected);
    }

    getAllTools(): MCPTool[] {
        const allTools: MCPTool[] = [];
        for (const tools of this.tools.values()) {
            allTools.push(...tools);
        }
        return allTools;
    }

    getAllResources(): MCPResource[] {
        const allResources: MCPResource[] = [];
        for (const resources of this.resources.values()) {
            allResources.push(...resources);
        }
        return allResources;
    }

    getAllPrompts(): MCPPrompt[] {
        const allPrompts: MCPPrompt[] = [];
        for (const prompts of this.prompts.values()) {
            allPrompts.push(...prompts);
        }
        return allPrompts;
    }

    destroy(): void {
        this.logger.log('Destroying MCP Client Manager');

        for (const serverId of this.servers.keys()) {
            this.disconnectFromServer(serverId);
        }

        this.servers.clear();
        this.connections.clear();
        this.tools.clear();
        this.resources.clear();
        this.prompts.clear();
        this.pendingRequests.clear();
    }
}
