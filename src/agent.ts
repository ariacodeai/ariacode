import type { ExecutionContext } from "./context.js";
import type { Tool, ToolResult } from "./tools.js";
import type { Provider, ProviderMessage } from "./provider.js";
import type { Config } from "./config.js";
import type { Database } from "better-sqlite3";
import { logMessage, logToolExecution, logMutation } from "./storage.js";
import { confirm, ConfirmCancelledError } from "./ui.js";

/**
 * User cancellation error — maps to exit code 130
 */
export class UserCancelledError extends Error {
  constructor() {
    super("Operation cancelled by user");
    this.name = "UserCancelledError";
  }
}

/**
 * Max iterations exceeded error
 */
export class MaxIterationsError extends Error {
  constructor(max: number) {
    super(`Agent reached maximum iterations (${max}) without completing`);
    this.name = "MaxIterationsError";
  }
}


/**
 * Execute a single tool call, enforcing mode and mutation rules.
 * Returns the ToolResult and whether the call was skipped (dry-run).
 */
async function executeToolCall(
  toolCall: { id: string; name: string; input: unknown },
  tools: Tool[],
  ctx: ExecutionContext,
  config: Config,
  db: Database | null
): Promise<{ result: ToolResult; skipped: boolean }> {
  const tool = tools.find((t) => t.name === toolCall.name);

  if (!tool) {
    return {
      result: {
        success: false,
        error: `Unknown tool: ${toolCall.name}`,
      },
      skipped: false,
    };
  }

  // Validate input against schema
  const parsed = tool.inputSchema.safeParse(toolCall.input);
  if (!parsed.success) {
    return {
      result: {
        success: false,
        error: `Invalid input for tool ${toolCall.name}: ${parsed.error.message}`,
      },
      skipped: false,
    };
  }

  // Enforce mutation rules
  if (tool.isMutation) {
    // Block all mutations in plan mode
    if (ctx.mode === "plan") {
      return {
        result: {
          success: false,
          error: `Tool '${toolCall.name}' is a mutation and cannot be used in plan mode`,
        },
        skipped: false,
      };
    }

    // Skip mutation tools in dry-run mode
    if (ctx.dryRun && (toolCall.name === "apply_diff" || toolCall.name === "apply_schema_change")) {
      return {
        result: {
          success: true,
          data: { skipped: true, reason: "dry-run mode — changes not applied" },
        },
        skipped: true,
      };
    }

    // Prompt for confirmation before applying changes (unless --yes)
    if (!ctx.assumeYes && (toolCall.name === "apply_diff" || toolCall.name === "apply_schema_change")) {
      try {
        const confirmMsg = toolCall.name === "apply_schema_change"
          ? "Apply the proposed schema changes to the filesystem?"
          : "Apply the proposed changes to the filesystem?";
        const confirmed = await confirm(confirmMsg);
        if (!confirmed) {
          throw new UserCancelledError();
        }
      } catch (err) {
        if (err instanceof ConfirmCancelledError) {
          throw new UserCancelledError();
        }
        throw err;
      }
    }
  }

  // Execute the tool
  const result = await tool.execute(parsed.data, ctx, config);

  // Log tool execution to database
  if (db) {
    logToolExecution(db, ctx.sessionId, toolCall.name, toolCall.input, result);

    // Log mutation if this was apply_diff or apply_schema_change and it succeeded
    if (
      (toolCall.name === "apply_diff" || toolCall.name === "apply_schema_change") &&
      result.success &&
      result.data &&
      typeof result.data === "object"
    ) {
      const data = result.data as {
        affectedFiles?: string[];
        rollbackHints?: string[];
      };
      const isSchemaChange = toolCall.name === "apply_schema_change";
      logMutation(db, ctx.sessionId, {
        action: toolCall.name,
        affectedFiles: data.affectedFiles ?? [],
        riskLevel: isSchemaChange ? "high" : "low",
        reversible: true,
        rollbackHints: data.rollbackHints,
      });
    }
  }

  return { result, skipped: false };
}

/**
 * Core agent loop.
 *
 * Sends the user request to the provider, executes tool calls, and iterates
 * until the provider signals end_turn or max_iterations is reached.
 *
 * Requirements: 9.1–9.6, 7.5, 7.6, 11.8, 11.9, 17.5, 17.6, 22.4
 */
export async function agentLoop(
  ctx: ExecutionContext,
  userRequest: string,
  tools: Tool[],
  provider: Provider,
  config: Config,
  _command: string,
  db: Database | null = null,
  systemPrompt?: string
): Promise<string> {
  const messages: ProviderMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: userRequest });

  // Log initial user message
  if (db) {
    logMessage(db, ctx.sessionId, "user", userRequest);
  }

  let iterations = 0;
  let lastContent = "";

  // Safety: cap the total number of messages to prevent unbounded memory growth.
  // Each iteration can add 2-3 messages (assistant + tool results), so
  // maxIterations * 3 + 2 (system + initial user) is a reasonable upper bound.
  const maxMessages = ctx.maxIterations * 3 + 10;

  while (iterations < ctx.maxIterations) {
    const response = await provider.chat(messages, tools, {
      model: ctx.model,
      maxTokens: config.provider.maxTokens,
    });

    // Stream assistant content to terminal as it arrives (Req 22.4)
    if (response.content) {
      process.stdout.write(response.content);
      lastContent = response.content;
    }

    // Log assistant message
    if (db && response.content) {
      logMessage(db, ctx.sessionId, "assistant", response.content);
    }

    messages.push({
      role: "assistant",
      content: response.content,
    });

    // Done — no more tool calls
    if (response.stopReason === "end_turn" || response.toolCalls.length === 0) {
      if (response.content) {
        process.stdout.write("\n");
      }
      return lastContent;
    }

    // Execute each tool call
    const toolResultParts: string[] = [];

    for (const toolCall of response.toolCalls) {
      const { result, skipped } = await executeToolCall(
        toolCall,
        tools,
        ctx,
        config,
        db
      );

      if (!skipped && !ctx.assumeYes && result.success && result.data) {
        // For non-mutation tools, show a brief indicator
        const isMutation = tools.find((t) => t.name === toolCall.name)?.isMutation;
        if (!isMutation) {
          process.stderr.write(`  [tool] ${toolCall.name}\n`);
        }
      }

      toolResultParts.push(
        JSON.stringify({
          tool_use_id: toolCall.id,
          type: "tool_result",
          content: result,
        })
      );
    }

    // Add tool results as a user message (standard agentic pattern)
    const toolResultMessage = toolResultParts.join("\n");
    messages.push({
      role: "user",
      content: toolResultMessage,
    });

    if (db) {
      logMessage(db, ctx.sessionId, "user", toolResultMessage);
    }

    // Trim old messages if we're approaching the cap to prevent unbounded growth.
    // Keep the system prompt (index 0) and the last N messages.
    if (messages.length > maxMessages) {
      const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
      const keep = Math.floor(maxMessages * 0.7);
      const trimmed = messages.slice(-keep);
      messages.length = 0;
      if (systemMsg) messages.push(systemMsg);
      messages.push(...trimmed);
    }

    iterations++;
  }

  throw new MaxIterationsError(ctx.maxIterations);
}


