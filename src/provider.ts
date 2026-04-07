import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 * Provider message format
 * Normalized across all providers
 */
export interface ProviderMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * Provider tool call format
 * Normalized across all providers
 */
export interface ProviderToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * Provider response format
 * Normalized across all providers
 */
export interface ProviderResponse {
  content: string;
  toolCalls: ProviderToolCall[];
  stopReason: "end_turn" | "max_tokens" | "tool_use";
}

/**
 * Tool definition for provider
 */
export interface Tool {
  name: string;
  description: string;
  isMutation: boolean;
  inputSchema: z.ZodSchema;
}

/**
 * Provider interface
 * All provider adapters must implement this interface
 */
export interface Provider {
  name: string;

  chat(
    messages: ProviderMessage[],
    tools: Tool[],
    options: {
      model: string;
      maxTokens: number;
      temperature?: number;
    },
  ): Promise<ProviderResponse>;
}

/**
 * Provider error with context
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

// ---------------------------------------------------------------------------
// Shared helpers for OpenAI-compatible providers
// ---------------------------------------------------------------------------

/**
 * Parse tool_calls from an OpenAI-compatible response message.
 * Shared by OpenAI, Ollama, and OpenRouter providers.
 */
function parseOpenAIToolCalls(
  toolCalls: Array<{
    id?: string;
    function: { name: string; arguments: string };
  }> | undefined,
): ProviderToolCall[] {
  if (!toolCalls) return [];

  return toolCalls.map((tc) => {
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(tc.function.arguments);
    } catch {
      parsedInput = {};
    }
    return {
      id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: tc.function.name,
      input: parsedInput,
    };
  });
}

/**
 * Map an OpenAI-compatible finish_reason to our normalized stopReason.
 */
function mapFinishReason(
  finishReason: string | undefined,
  toolCallCount: number,
): "end_turn" | "max_tokens" | "tool_use" {
  if (finishReason === "stop" || finishReason === "end_turn") return "end_turn";
  if (finishReason === "length" || finishReason === "max_tokens") return "max_tokens";
  if (finishReason === "tool_calls" || finishReason === "tool_use") return "tool_use";
  // Infer from tool calls (Ollama doesn't always provide finish_reason)
  return toolCallCount > 0 ? "tool_use" : "end_turn";
}

/**
 * Convert tools to OpenAI-compatible function format.
 * Shared by OpenAI, Ollama, and OpenRouter providers.
 */
function toOpenAITools(tools: Tool[]): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.inputSchema),
    },
  }));
}

/**
 * Validate that an OpenAI-compatible response has the expected structure.
 * Throws a descriptive error if the response is malformed.
 */
function validateOpenAIResponse(
  data: unknown,
  providerName: string,
): { content: string; tool_calls?: Array<{ id?: string; function: { name: string; arguments: string } }>; finish_reason?: string } {
  if (!data || typeof data !== "object") {
    throw new Error(`Unexpected ${providerName} response: not an object`);
  }

  const obj = data as Record<string, unknown>;
  const choices = obj.choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(`Unexpected ${providerName} response: missing or empty choices array`);
  }

  const choice = choices[0] as Record<string, unknown>;
  const message = choice?.message;

  if (!message || typeof message !== "object") {
    throw new Error(`Unexpected ${providerName} response: missing choices[0].message`);
  }

  const msg = message as Record<string, unknown>;
  return {
    content: typeof msg.content === "string" ? msg.content : "",
    tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : undefined,
    finish_reason: typeof choice.finish_reason === "string" ? choice.finish_reason : undefined,
  };
}


// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

/**
 * Anthropic provider adapter
 * Uses @anthropic-ai/sdk
 */
export class AnthropicProvider implements Provider {
  name = "anthropic";
  private client: Anthropic;

  constructor(apiKey?: string) {
    const key = apiKey || process.env.ANTHROPIC_API_KEY;

    if (!key) {
      throw new ProviderError(
        "ANTHROPIC_API_KEY environment variable is required",
        "anthropic",
      );
    }

    this.client = new Anthropic({ apiKey: key });
  }

  async chat(
    messages: ProviderMessage[],
    tools: Tool[],
    options: {
      model: string;
      maxTokens: number;
      temperature?: number;
    },
  ): Promise<ProviderResponse> {
    try {
      const systemMessages = messages.filter((m) => m.role === "system");
      const conversationMessages = messages.filter((m) => m.role !== "system");
      const systemPrompt = systemMessages.map((m) => m.content).join("\n\n");

      const anthropicTools = tools.map((tool) => {
        const schema = zodToJsonSchema(tool.inputSchema);
        return {
          name: tool.name,
          description: tool.description,
          input_schema: { type: "object" as const, ...schema },
        };
      });

      const anthropicMessages = conversationMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      const response = await this.client.messages.create({
        model: options.model,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        system: systemPrompt || undefined,
        messages: anthropicMessages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      });

      let content = "";
      const toolCalls: ProviderToolCall[] = [];

      for (const block of response.content) {
        if (block.type === "text") {
          content += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({ id: block.id, name: block.name, input: block.input });
        }
      }

      return {
        content,
        toolCalls,
        stopReason: mapFinishReason(response.stop_reason ?? undefined, toolCalls.length),
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        `Anthropic API error: ${error instanceof Error ? error.message : String(error)}`,
        "anthropic",
        error,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible base provider
// ---------------------------------------------------------------------------

/**
 * Base class for OpenAI-compatible providers (OpenAI, Ollama, OpenRouter).
 * Eliminates duplicated fetch + parse + error handling logic.
 */
abstract class OpenAICompatibleProvider implements Provider {
  abstract name: string;

  /** Timeout for API requests in milliseconds (default: 2 minutes). */
  protected getTimeoutMs(): number {
    return 120_000;
  }

  protected abstract getEndpoint(): string;
  protected abstract getHeaders(): Record<string, string>;
  protected abstract buildBody(
    messages: ProviderMessage[],
    tools: Tool[],
    options: { model: string; maxTokens: number; temperature?: number },
  ): Record<string, unknown>;

  async chat(
    messages: ProviderMessage[],
    tools: Tool[],
    options: { model: string; maxTokens: number; temperature?: number },
  ): Promise<ProviderResponse> {
    try {
      const response = await fetch(this.getEndpoint(), {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(this.buildBody(messages, tools, options)),
        signal: AbortSignal.timeout(this.getTimeoutMs()),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `${this.name} API error: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`,
        );
      }

      const data: unknown = await response.json();
      const validated = validateOpenAIResponse(data, this.name);
      const toolCalls = parseOpenAIToolCalls(validated.tool_calls);

      return {
        content: validated.content,
        toolCalls,
        stopReason: mapFinishReason(validated.finish_reason, toolCalls.length),
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        `${this.name} API error: ${error instanceof Error ? error.message : String(error)}`,
        this.name,
        error,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Concrete OpenAI-compatible providers
// ---------------------------------------------------------------------------

export class OpenAIProvider extends OpenAICompatibleProvider {
  name = "openai";
  private apiKey: string;

  constructor(apiKey?: string) {
    super();
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) {
      throw new ProviderError("OPENAI_API_KEY environment variable is required", "openai");
    }
    this.apiKey = key;
  }

  protected getEndpoint(): string {
    return "https://api.openai.com/v1/chat/completions";
  }

  protected getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  protected buildBody(
    messages: ProviderMessage[],
    tools: Tool[],
    options: { model: string; maxTokens: number; temperature?: number },
  ): Record<string, unknown> {
    const openaiTools = toOpenAITools(tools);
    return {
      model: options.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
    };
  }
}

export class OllamaProvider extends OpenAICompatibleProvider {
  name = "ollama";
  private baseUrl: string;

  constructor(baseUrl?: string) {
    super();
    this.baseUrl = baseUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  }

  protected getEndpoint(): string {
    return `${this.baseUrl}/api/chat`;
  }

  protected getHeaders(): Record<string, string> {
    return { "Content-Type": "application/json" };
  }

  protected buildBody(
    messages: ProviderMessage[],
    tools: Tool[],
    options: { model: string; maxTokens: number; temperature?: number },
  ): Record<string, unknown> {
    const ollamaTools = toOpenAITools(tools);
    return {
      model: options.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      tools: ollamaTools.length > 0 ? ollamaTools : undefined,
      stream: false,
      options: {
        temperature: options.temperature,
        num_predict: options.maxTokens,
      },
    };
  }

  /**
   * Override chat for Ollama's different response shape:
   * { message: { content, tool_calls } } instead of { choices: [...] }
   */
  async chat(
    messages: ProviderMessage[],
    tools: Tool[],
    options: { model: string; maxTokens: number; temperature?: number },
  ): Promise<ProviderResponse> {
    try {
      const response = await fetch(this.getEndpoint(), {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(this.buildBody(messages, tools, options)),
        signal: AbortSignal.timeout(this.getTimeoutMs()),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `ollama API error: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`,
        );
      }

      const data = (await response.json()) as Record<string, unknown>;
      const message = data?.message as Record<string, unknown> | undefined;

      if (!message) {
        throw new Error("Unexpected Ollama response format: missing message");
      }

      const content = typeof message.content === "string" ? message.content : "";
      const toolCalls = parseOpenAIToolCalls(
        Array.isArray(message.tool_calls) ? message.tool_calls : undefined,
      );

      return {
        content,
        toolCalls,
        stopReason: mapFinishReason(undefined, toolCalls.length),
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        `ollama API error: ${error instanceof Error ? error.message : String(error)}`,
        "ollama",
        error,
      );
    }
  }
}

export class OpenRouterProvider extends OpenAICompatibleProvider {
  name = "openrouter";
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    super();
    const key = apiKey || process.env.OPENROUTER_API_KEY;
    if (!key) {
      throw new ProviderError("OPENROUTER_API_KEY environment variable is required", "openrouter");
    }
    this.apiKey = key;
    this.baseUrl = baseUrl || process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  }

  protected getEndpoint(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  protected getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "HTTP-Referer": "https://github.com/ariacodeai/ariacode",
      "X-Title": "Aria Code CLI",
    };
  }

  protected buildBody(
    messages: ProviderMessage[],
    tools: Tool[],
    options: { model: string; maxTokens: number; temperature?: number },
  ): Record<string, unknown> {
    const openrouterTools = toOpenAITools(tools);
    return {
      model: options.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      tools: openrouterTools.length > 0 ? openrouterTools : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Zod → JSON Schema converter
// ---------------------------------------------------------------------------

/**
 * Convert Zod v4 schema to JSON Schema for tool definitions.
 *
 * Zod v4 uses `_def.type` (string) instead of Zod v3's `_def.typeName`.
 * This converter handles both formats for compatibility.
 *
 * Throws on unsupported types instead of silently falling back.
 */
export function zodToJsonSchema(schema: z.ZodSchema): Record<string, unknown> {
  const def = (schema as any)._def;
  if (!def) {
    return { type: "string" };
  }

  // Zod v3 uses typeName, Zod v4 uses type
  const typeName: string | undefined = def.typeName ?? def.type;

  switch (typeName) {
    case "ZodObject":
    case "object": {
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value as z.ZodSchema);
        const fieldDef = (value as any)._def;
        const fieldType = fieldDef?.typeName ?? fieldDef?.type;
        if (fieldType !== "ZodOptional" && fieldType !== "optional" &&
            fieldType !== "ZodDefault" && fieldType !== "default") {
          required.push(key);
        }
      }

      return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }

    case "ZodString":
    case "string":
      return { type: "string" };

    case "ZodNumber":
    case "number":
      return { type: "number" };

    case "ZodBoolean":
    case "boolean":
      return { type: "boolean" };

    case "ZodArray":
    case "array": {
      // Zod v3: def.type is the element schema; Zod v4: def.element
      const element = def.element ?? def.type;
      return { type: "array", items: zodToJsonSchema(element) };
    }

    case "ZodOptional":
    case "optional":
      return zodToJsonSchema(def.innerType);

    case "ZodDefault":
    case "default":
      return zodToJsonSchema(def.innerType);

    case "ZodNullable":
    case "nullable": {
      const inner = zodToJsonSchema(def.innerType);
      return { ...inner, nullable: true };
    }

    case "ZodEnum":
    case "enum": {
      // Zod v3: def.values is an array; Zod v4: def.entries is an object
      const values = def.values ?? (def.entries ? Object.keys(def.entries) : []);
      return { type: "string", enum: values };
    }

    case "ZodLiteral":
    case "literal": {
      const val = def.value;
      if (typeof val === "string") return { type: "string", const: val };
      if (typeof val === "number") return { type: "number", const: val };
      if (typeof val === "boolean") return { type: "boolean", const: val };
      return { const: val };
    }

    case "ZodUnion":
    case "union": {
      const options = ((def.options ?? def.members) as z.ZodSchema[]).map(zodToJsonSchema);
      return { anyOf: options };
    }

    case "ZodRecord":
    case "record":
      return {
        type: "object",
        additionalProperties: zodToJsonSchema(def.valueType),
      };

    case "ZodAny":
    case "any":
      return {};

    default: {
      // Fallback: Zod v4 .describe() / .uuid() etc. may strip typeName
      // but the schema instance itself has a `type` property
      const instanceType = (schema as any).type;
      if (instanceType === "string") return { type: "string" };
      if (instanceType === "number") return { type: "number" };
      if (instanceType === "boolean") return { type: "boolean" };

      throw new Error(
        `zodToJsonSchema: unsupported Zod type "${typeName}". ` +
          `Add support or use a simpler schema.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a provider instance based on configuration
 */
export function createProvider(providerName: string, config?: { openrouter?: { baseUrl?: string } }): Provider {
  switch (providerName) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider();
    case "ollama":
      return new OllamaProvider();
    case "openrouter":
      return new OpenRouterProvider(undefined, config?.openrouter?.baseUrl);
    default:
      throw new ProviderError(`Unsupported provider: ${providerName}`, providerName);
  }
}
