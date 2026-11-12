/*
 * What the codex adapter declares per tested CLI version (plan 4.5, the sandboxed-exec exception).
 *
 * The offer check is exact membership in the declared list (N29): a leg fails when any offered name is outside
 * it. A version with no declared list is refused at preflight, so the adapter never guesses.
 *
 * Offers use namespaced names (`functions.exec`, `clock.sleep`); calls use short names (`exec`, `sleep`, `wait`)
 * plus a namespace on function calls. The use-time rules are keyed on call names, through the explicit map below
 * (N28).
 */

/** How a call is ratified at use time (plan 4.5). */
export type CallClass =
  /** `exec`: the command channel. Every `cmd` is extracted and checked (4.2). */
  | 'command'
  /** Starts a child agent. The child's own rollout must ratify (N30). */
  | 'spawn'
  /** Acts on another agent; the target must be one of this leg's own agents (N30). */
  | 'targeted'
  /** Waits on time or on this leg's own agents; explicit targets must be this leg's own (N30). */
  | 'wait'
  /** Lists this leg's agents. */
  | 'list'
  /** Asks for user input. Allowed but has nothing to answer it headless; recorded (N31: bounded by the cap). */
  | 'input'
  /** A custom tool that only reads (N18). */
  | 'read';

export interface CallRule {
  /** The offer name the call maps to (N28). */
  offer: string;
  class: CallClass;
}

export interface CodexVersionDecl {
  /** `world_state.state.top_level_tools`, copied verbatim from the recorded rollouts of this version. */
  nativeOffer: readonly string[];
  /** Call name (`namespace.name`, or the bare name for calls that carry no namespace) to its offer and class. */
  calls: Readonly<Record<string, CallRule>>;
  /**
   * Custom tools outside the command channel that count as reads (N18). Empty for 0.167.0: every offered name is
   * classified above, and nothing else may be offered.
   */
  readCalls: readonly string[];
  /**
   * The nested tools the `exec` script can call (`tools.<name>(...)`), as the exec tool's own description lists
   * them, each with its use rule. These sit inside `functions.exec`, so they never appear in
   * `top_level_tools`; preflight checks that the rendered description lists exactly these names.
   */
  execNested: Readonly<Record<string, NestedRule>>;
  /** The argument names `exec_command` declares. Any other key fails closed. */
  execCommandArgs: readonly string[];
  /**
   * The `item_completed` item types the runtime records for this version (measured), and how each is ratified.
   * Every nested tool call leaves an item (`CommandExecution`, `ImageView` with its path, `McpToolCall`,
   * `FileChange`), so this check catches a call the static exec scanner cannot read, such as one reached through a
   * key built at run time. Any type not listed fails the leg.
   */
  recordItems: Readonly<Record<string, RecordItemRule>>;
}

/** How one recorded item type is ratified. */
export type RecordItemRule =
  | 'conversation' // messages, reasoning and the leg's own agent tree
  | 'command' // checked by the commands check
  | 'image' // its path must be inside the root
  | 'mcp-list'; // only the runtime's own list_mcp_resources / list_mcp_resource_templates


/** How a nested exec tool is ratified (N18). */
export interface NestedRule {
  class: 'command' | 'read' | 'forbidden';
  why: string;
}

const CODEX_0_167_0: CodexVersionDecl = {
  nativeOffer: [
    'clock',
    'clock.sleep',
    'collaboration',
    'collaboration.followup_task',
    'collaboration.interrupt_agent',
    'collaboration.list_agents',
    'collaboration.send_message',
    'collaboration.spawn_agent',
    'collaboration.wait_agent',
    'functions',
    'functions.exec',
    'functions.request_user_input',
    'functions.request_user_input_async',
    'functions.wait',
  ],
  calls: {
    exec: { offer: 'functions.exec', class: 'command' },
    'functions.exec': { offer: 'functions.exec', class: 'command' },
    wait: { offer: 'functions.wait', class: 'wait' },
    'functions.wait': { offer: 'functions.wait', class: 'wait' },
    request_user_input: { offer: 'functions.request_user_input', class: 'input' },
    'functions.request_user_input': { offer: 'functions.request_user_input', class: 'input' },
    request_user_input_async: { offer: 'functions.request_user_input_async', class: 'input' },
    'functions.request_user_input_async': { offer: 'functions.request_user_input_async', class: 'input' },
    sleep: { offer: 'clock.sleep', class: 'wait' },
    'clock.sleep': { offer: 'clock.sleep', class: 'wait' },
    'collaboration.spawn_agent': { offer: 'collaboration.spawn_agent', class: 'spawn' },
    // followup_task re-tasks one of this leg's agents; any child it starts is ratified like a spawn (N30).
    'collaboration.followup_task': { offer: 'collaboration.followup_task', class: 'targeted' },
    'collaboration.send_message': { offer: 'collaboration.send_message', class: 'targeted' },
    'collaboration.interrupt_agent': { offer: 'collaboration.interrupt_agent', class: 'targeted' },
    'collaboration.wait_agent': { offer: 'collaboration.wait_agent', class: 'wait' },
    'collaboration.list_agents': { offer: 'collaboration.list_agents', class: 'list' },
  },
  readCalls: [],
  // Measured from the 0.167.0 exec description (codex debug prompt-input), and from a live leg that called
  // list_mcp_resources and list_mcp_resource_templates from inside exec.
  execNested: {
    exec_command: { class: 'command', why: 'the command channel: cmd, workdir and sandbox_permissions are checked' },
    clock__curr_time: { class: 'read', why: 'reads the clock' },
    list_mcp_resources: { class: 'read', why: 'lists MCP resources; every MCP server is disabled by name, so the list is empty (measured)' },
    list_mcp_resource_templates: { class: 'read', why: 'lists MCP resource templates; empty for the same reason (measured)' },
    view_image: { class: 'read', why: 'reads a local image; its path must be inside the root' },
    apply_patch: { class: 'forbidden', why: 'edits files (write-class)' },
    write_stdin: { class: 'forbidden', why: 'feeds an interactive session, which bypasses the command parse' },
    read_mcp_resource: { class: 'forbidden', why: 'reads content from an MCP server (MCP-class)' },
  },
  execCommandArgs: [
    'cmd',
    'justification',
    'login',
    'max_output_tokens',
    'prefix_rule',
    'sandbox_permissions',
    'shell',
    'tty',
    'workdir',
    'yield_time_ms',
  ],
  // Measured on 0.167.0: the item types in every rollout of 2026-11 (UserMessage, AgentMessage, Reasoning,
  // CommandExecution, SubAgentActivity, CollabAgentToolCall, McpToolCall, FileChange, Extension), plus one live
  // nested view_image call, which recorded `ImageView` with a `file://` path. FileChange (apply_patch) and Extension
  // (web.search) are not listed, so they fail.
  recordItems: {
    UserMessage: 'conversation',
    AgentMessage: 'conversation',
    Reasoning: 'conversation',
    SubAgentActivity: 'conversation',
    CollabAgentToolCall: 'conversation',
    CommandExecution: 'command',
    ImageView: 'image',
    McpToolCall: 'mcp-list',
  },
};

/** Declared per tested version. Anything else is refused at preflight. */
export const CODEX_DECLARED: Readonly<Record<string, CodexVersionDecl>> = {
  '0.167.0': CODEX_0_167_0,
};

export const CODEX_TESTED_VERSIONS = Object.keys(CODEX_DECLARED);

export function codexDecl(version: string | null): CodexVersionDecl | null {
  if (version === null) return null;
  return CODEX_DECLARED[version] ?? null;
}

/** Resolves a recorded call to its rule (N28). Unknown calls return null and fail the leg. */
export function callRule(decl: CodexVersionDecl, name: string, namespace: string | null): CallRule | null {
  const key = namespace !== null && namespace !== '' ? `${namespace}.${name}` : name;
  const rule = decl.calls[key];
  if (rule) return rule;
  if (decl.readCalls.includes(key)) return { offer: key, class: 'read' };
  return null;
}
