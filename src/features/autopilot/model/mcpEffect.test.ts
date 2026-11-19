// What an MCP tool call does, judged from its name (and a description or the server's annotations when a call carries
// them). The tables are Row-Bot's own (tests/contracts/test_mcp_contract.py,
// tests/subsystem/integrations/test_runner_and_access.py, tests/subsystem/mcp/test_mcp_client.py and
// test_phase4_dispatch_authority.py), with Row-Bot's "mutation" read here as "change" and its "interaction" as a
// change too: Hivra lets nothing but a read pass. The rest are Hivra's own cases: the server a tool comes from, and
// the names real servers use.
import { describe, expect, it } from "vitest";
import { isHighImpactTool, sanitizeNameComponent, splitMcpTool, toolEffect, type McpHints } from "./mcpEffect";

describe("names", () => {
  it("reads a tool name as words", () => {
    // Ported from test_mcp_safety.py, plus Row-Bot's prefixed_tool_name case.
    expect(sanitizeNameComponent("File Server!")).toBe("file_server");
    expect(sanitizeNameComponent("  ")).toBe("unnamed");
    expect(sanitizeNameComponent("")).toBe("unnamed");
    // Change from Row-Bot: JavaScript servers run words together, so camelCase is split.
    expect(sanitizeNameComponent("chat_postMessage")).toBe("chat_post_message");
    expect(sanitizeNameComponent("getURL")).toBe("get_url");
    expect(sanitizeNameComponent("HTTPServerList")).toBe("http_server_list");
  });

  it("splits a provider tool id into its server and its tool", () => {
    expect(splitMcpTool("mcp__plugin-a-b__get_x")).toEqual({ server: "plugin-a-b", tool: "get_x" });
    expect(splitMcpTool("mcp__claude_ai_Firecrawl__firecrawl_scrape")).toEqual({
      server: "claude_ai_Firecrawl",
      tool: "firecrawl_scrape",
    });
    for (const name of ["Bash", "mcp__x", "mcp____x", "mcp__x__", "mcp_x__y", ""]) expect(splitMcpTool(name), name).toBeNull();
  });
});

/** Row-Bot's tables, one row each. "mutation" is Hivra's "change"; "interaction" is a change too. */
const TABLES: readonly { name: string; description?: string; hints?: McpHints; expected: ReturnType<typeof toolEffect> }[] = [
  // test_mcp_safety.py
  { name: "browser_click", description: "click a browser target", expected: "change" },
  { name: "delete_file", description: "remove a file", expected: "high_impact" },
  { name: "inspect", description: "read-only", hints: { readOnlyHint: true }, expected: "read_only" },
  // test_runner_and_access.py, first table
  { name: "get_record", expected: "read_only" },
  { name: "update_record", expected: "change" },
  { name: "create_issue", hints: { readOnlyHint: true }, expected: "change" },
  { name: "tag_issue", expected: "change" },
  { name: "get_label", hints: { readOnlyHint: true }, expected: "read_only" },
  { name: "list_by_tag", expected: "read_only" },
  { name: "create_release", expected: "high_impact" },
  { name: "add_collaborator", expected: "high_impact" },
  { name: "set_password", hints: { readOnlyHint: true }, expected: "high_impact" },
  { name: "create_pull_request", expected: "high_impact" },
  { name: "list_members", expected: "read_only" },
  { name: "reset_workspace", expected: "high_impact" },
  { name: "add_user_to_org", expected: "high_impact" },
  { name: "update_repository_visibility", expected: "high_impact" },
  { name: "delete_record", expected: "high_impact" },
  { name: "send_message", expected: "high_impact" },
  { name: "add_comment", expected: "high_impact" },
  { name: "upload_file", expected: "high_impact" },
  { name: "push_files", expected: "high_impact" },
  { name: "merge_pull_request", expected: "high_impact" },
  { name: "create_repository", expected: "high_impact" },
  { name: "create_branch", expected: "change" },
  // Held since WP-101 fix round 2, item E: a file name's arguments decide which file it reads, and they are not seen.
  { name: "get_file_contents", expected: "unknown" },
  { name: "lookup", hints: { destructiveHint: true }, expected: "high_impact" },
  { name: "frobnicate", expected: "unknown" },
  { name: "frobnicate", hints: { readOnlyHint: false, destructiveHint: false }, expected: "unknown" },
  { name: "browser_close", expected: "change" },
  // test_runner_and_access.py, second table
  { name: "get_commit", description: "Get details for a commit from a GitHub repository", expected: "read_only" },
  { name: "list_commits", description: "Get list of commits of a branch in a GitHub repository", expected: "read_only" },
  // WP-101 fix round 2, item E: "run" names what a run script does, so the name alone can't be read.
  { name: "get_workflow_run", description: "Get details of a specific workflow run", expected: "unknown" },
  { name: "get_order", description: "Get an order by its id", expected: "read_only" },
  { name: "get_and_push", expected: "high_impact" },
  { name: "get_commit", hints: { destructiveHint: true }, expected: "high_impact" },
  { name: "get_commit", description: "Get a commit and push it to main", expected: "unknown" },
  { name: "list_workflow_runs", description: "List workflow runs and cancel stale ones", expected: "unknown" },
  { name: "read_delete_log", expected: "high_impact" },
  { name: "commit_changes", expected: "high_impact" },
  { name: "search_book_flight", description: "Search and book a flight", expected: "high_impact" },
  { name: "fetch_to_upload", expected: "high_impact" },
  // WP-101 fix round 2, item E: "run" and "artifact" say a run, whose arguments the check never sees.
  { name: "list_workflow_run_artifacts", expected: "unknown" },
  { name: "get_post", description: "Get a post or post a new one", expected: "unknown" },
  { name: "run_query", expected: "high_impact" },
  { name: "edit_file", description: "Make line-based edits to a text file in an allowed folder", expected: "change" },
  { name: "create_or_update_file", description: "Create or update a single file in a GitHub repository", expected: "high_impact" },
  { name: "get_or_make_page", description: "Update the page, creating it when missing", expected: "unknown" },
  { name: "collaborator", description: "Add a collaborator to a repository", expected: "unknown" },
  // WP-101 fix round: Row-Bot reads a readOnlyHint as the server's word. Here a description or an annotation can only
  // make a verdict stricter, never looser, so this one stays unknown and waits.
  { name: "get_page", description: "Update the page", hints: { readOnlyHint: true }, expected: "unknown" },
  // test_mcp_contract.py
  { name: "lookup", description: "Look a record up", hints: { destructiveHint: true }, expected: "high_impact" },
  // Stricter than Row-Bot for the same reason: its description says "Execute".
  { name: "check_stock", description: "Execute a stock check", hints: { readOnlyHint: true }, expected: "unknown" },
  { name: "delete_order", hints: { readOnlyHint: true }, expected: "high_impact" },
  { name: "save_purchase_orders", hints: { readOnlyHint: true }, expected: "change" },
  // Stricter than Row-Bot (WP-101 fix round 2, item E): the query the tool runs is an argument the check never sees.
  { name: "read_query", description: "Execute a SELECT query on the SQLite database", expected: "unknown" },
  // Same reason: a doc is read from wherever the server keeps it, which the name can't say.
  { name: "search_docs", description: "Run a search over the docs", expected: "unknown" },
  { name: "append_insight", description: "Add a business insight to the memo", expected: "change" },
  { name: "save_purchase_orders", description: "Save purchase orders to the ledger", hints: { readOnlyHint: false }, expected: "change" },
  { name: "list_purchase_orders", description: "List purchase orders", hints: { readOnlyHint: false }, expected: "unknown" },
  { name: "write_query", description: "Execute an INSERT, UPDATE, or DELETE query on the SQLite database", expected: "high_impact" },
  { name: "create_pages", description: "Create pages and share them with your team", expected: "high_impact" },
  { name: "create_pages", description: "Create pages and share them with your team", hints: { destructiveHint: false }, expected: "change" },
  { name: "delete_pages", description: "Delete pages", hints: { destructiveHint: false }, expected: "high_impact" },
  { name: "get_or_make_page", description: "Update the page, creating it when missing", expected: "unknown" },
  { name: "query", description: "Execute any SQL statement against the database", expected: "unknown" },
  { name: "query", description: "Execute a GraphQL query or mutation", expected: "unknown" },
  { name: "lookup", description: "Look up an order and refund it", expected: "unknown" },
  { name: "search", description: "Search issues and comment on them", expected: "unknown" },
  { name: "query", description: "Executes any SQL statement", expected: "unknown" },
  { name: "query", description: "Runs arbitrary SQL, including inserts, updates and deletes", expected: "unknown" },
  { name: "read_query", description: "Executes a SELECT query, then drops the table", expected: "unknown" },
  { name: "search_files", description: "Run a search and replace across files", expected: "unknown" },
  { name: "query", description: "Execute a SELECT INTO statement", expected: "unknown" },
  { name: "list_orders", description: "List recent orders", expected: "read_only" },
  { name: "get_posts", description: "Get the latest posts and their comments", expected: "read_only" },
  { name: "terminal", description: "Execute a shell command", expected: "high_impact" },
  { name: "frobnicate", description: "Does a thing", expected: "unknown" },
  // test_mcp_client.py
  { name: "search_messages", expected: "read_only" },
  { name: "update_index", hints: { readOnlyHint: true, destructiveHint: false }, expected: "change" },
  { name: "lookup", hints: { destructiveHint: true }, expected: "high_impact" },
  { name: "browser_evaluate", description: "Evaluate JavaScript expression on page or element", hints: { destructiveHint: true }, expected: "high_impact" },
  { name: "browser_run_code", description: "Run Playwright code snippet", hints: { destructiveHint: true }, expected: "high_impact" },
  { name: "browser_file_upload", description: "Upload one or multiple files", hints: { destructiveHint: true }, expected: "high_impact" },
  { name: "browser_navigate", description: "Navigate to a URL", hints: { destructiveHint: true }, expected: "high_impact" },
  { name: "browser_fill_form", description: "Fill multiple form fields", hints: { destructiveHint: true }, expected: "high_impact" },
  { name: "browser_navigate", description: "Navigate to a URL", hints: { readOnlyHint: true, destructiveHint: false }, expected: "change" },
  { name: "xquik", description: "Execute API calls against your Xquik account.", expected: "high_impact" },
  // test_phase4_dispatch_authority.py
  // Stricter than Row-Bot (WP-101 fix round 2, item E): a file read's arguments decide which file it names.
  { name: "read_file", expected: "unknown" },
  { name: "browser_snapshot", expected: "read_only" },
  { name: "browser_click", expected: "change" },
  { name: "browser_click", hints: { destructiveHint: true, readOnlyHint: true }, expected: "high_impact" },
  { name: "read_and_delete_file", hints: { readOnlyHint: true }, expected: "high_impact" },
  { name: "opaque_operation", expected: "unknown" },
  // Stricter than Row-Bot: a hint can't turn a name outside the vocabulary into a read.
  { name: "opaque_operation", hints: { readOnlyHint: true }, expected: "unknown" },
  { name: "opaque_operation", expected: "unknown" },
  { name: "get_and_process", hints: { readOnlyHint: false }, expected: "unknown" },
];

describe("what a tool does (Row-Bot's tables)", () => {
  it.each(TABLES.map((row) => [row.name, row.description ?? "", row.hints ?? {}, row.expected]))(
    "%s (%s, %o) is %s",
    (name, description, hints, expected) => {
      expect(toolEffect(name, description, hints)).toBe(expected);
    },
  );

  it("still knows which of these are high impact", () => {
    // Row-Bot's second column, checked against the same table: high impact is exactly what always asks.
    for (const row of TABLES) {
      expect(isHighImpactTool(row.name, row.description ?? "", row.hints ?? {}), row.name).toBe(row.expected === "high_impact");
    }
  });
});

describe("a read is a closed vocabulary, never a guess (WP-101 fix round)", () => {
  /** The review's rows 3 to 7: every one of these was approved before this round. */
  const REVIEW_HELD = [
    // row 3: a read verb first, another verb after it
    "get_status_and_restart",
    "status_restart",
    "search_and_replace",
    "find_replace",
    "get_replace",
    "get_clear",
    // row 4: look-alike and non-Latin letters
    "get_dеlete",
    "get_удалить",
    "read_删除",
    "get_sеnd_email",
    "list_ѕеnd",
    "get_ѕhell",
    "read_ехес",
    // row 5: write verbs the old blacklist did not list
    ...["start", "stop", "restart", "reboot", "apply", "rotate", "enable", "disable", "sync", "launch", "trigger", "invoke", "call", "install", "download", "upload", "open", "navigate", "restore", "rollback", "revert", "approve", "reject", "lock", "unlock", "ban", "block", "subscribe", "login", "connect", "mount", "flush", "clean", "prune", "export", "import", "clone", "mint", "burn", "swap", "stake", "claim", "redeem"].flatMap((verb) => [
      `get_${verb}`,
      `read_${verb}`,
      `list_${verb}`,
      `fetch_${verb}`,
    ]),
    // row 6: a secret named after a read verb
    "read_secret",
    "get_token",
    "read_password",
    "get_credentials",
    "get_api_key",
    "list_secrets",
    "get_env",
    "read_ssh_key",
    "read_keychain",
    "get_secret_value",
    // row 7: network
    "fetch_url",
    "get_url",
    "fetch_to_url",
    "fetch_exfiltrate",
    "fetch",
    "get_remote",
  ];

  it("holds every tool name from the review's rows 3 to 7", () => {
    // Held means it waits: unknown, or high impact when it names a secret (rows 6).
    for (const name of REVIEW_HELD) expect(["unknown", "high_impact"], name).toContain(toolEffect(name));
    // Only a secret makes one of these high impact; the rest are unknown.
    const secrets = new Set(["read_secret", "get_token", "read_password", "get_credentials", "get_api_key", "list_secrets", "get_env", "read_ssh_key", "read_keychain", "get_secret_value"]);
    for (const name of REVIEW_HELD) if (!secrets.has(name)) expect(toolEffect(name), name).toBe("unknown");
  });

  it("names a secret's tool high impact, so it always waits", () => {
    expect(toolEffect("read_secret")).toBe("high_impact");
    expect(toolEffect("get_token")).toBe("high_impact");
  });

  it("still reads the plain read names for a trusted server", () => {
    // WP-101 fix round 2, item E: a file, page or path name waits; the records a server keeps do not.
    for (const name of ["get_status", "get_issue", "list_pull_requests", "search_issues", "list_issues", "list_branches", "get_commit"])
      expect(toolEffect(name), name).toBe("read_only");
  });

  it("holds a name with a joining word, an empty token list, or no parseable words", () => {
    // Each waits: unknown, or a change or high impact, which wait too. None is a read.
    for (const name of ["get_and_delete", "read_then_write", "list_or_create", "_", "__", "get__page", "  ", ""])
      expect(toolEffect(name), name).not.toBe("read_only");
    for (const name of ["_", "__", "get__page", "  ", ""]) expect(toolEffect(name), name).toBe("unknown");
    // A joining word with a secret still names a secret, so it is held as high impact.
    expect(toolEffect("get_with_token")).toBe("high_impact");
  });

  it("counts a sensitive noun anywhere as high impact, never as a read", () => {
    for (const name of ["read_secret", "get_token", "list_passwords", "get_credential", "read_api_key", "get_env", "read_ssh_key", "get_keychain", "read_cookie", "get_session", "read_auth", "get_private_data"])
      expect(isHighImpactTool(name), name).toBe(true);
  });

  it("never lets a description or an annotation make a held name pass", () => {
    for (const name of ["get_status_and_restart", "read_secret", "get_dеlete", "get_start"])
      expect(toolEffect(name, "Read-only: fetch a page", { readOnlyHint: true }), name).not.toBe("read_only");
  });
});

describe("Hivra's own cases", () => {
  it("reads the names real servers use", () => {
    // get_file waits since fix round 2, item E: which file it reads is an argument the approval request doesn't carry.
    for (const name of ["list_issues", "describe_instance", "get_commit_status", "get_posts", "search_issues"])
      expect(toolEffect(name), name).toBe("read_only");
    expect(toolEffect("get_file")).toBe("unknown");
    for (const name of ["create_page", "update_settings", "move_file", "rename_file"]) expect(toolEffect(name), name).toBe("change");
    for (const name of ["delete_file", "send_message", "publish_site", "run_shell_command", "add_member"]) expect(toolEffect(name), name).toBe("high_impact");
  });

  it("reads a camelCase name as words", () => {
    expect(toolEffect("getUser")).toBe("read_only");
    expect(toolEffect("deleteUser")).toBe("high_impact");
    expect(toolEffect("listProjects")).toBe("read_only");
  });

  it("holds every name whose arguments, not its name, decide what it reads (fix round 2, item E)", () => {
    // The review's rows 5 and 6: the approval request carries no arguments, so a page, URL, file, path, shell or SQL
    // tool can be pointed anywhere. None of these may pass on a trusted server.
    for (const name of [
      "get_page",
      "read_page",
      "fetch_page",
      "get_url",
      "fetch_url",
      "get_link",
      "read_uri",
      "fetch",
      "get_document",
      "read_doc",
      "read_file",
      "get_file",
      "list_files",
      "get_file_contents",
      "read_blob",
      "get_content",
      "read_path",
      "list_folder",
      "get_directory",
      "run_sql",
      "get_sql",
      "run_shell",
      "exec_command",
      "eval",
      "browse",
      "get_web_page",
    ])
      expect(toolEffect(name), name).not.toBe("read_only");
    // A bare verb has no object at all, so only the call says what it reads.
    for (const name of ["query", "read_query", "get_query", "search", "fetch"]) expect(toolEffect(name), name).not.toBe("read_only");
  });

  it("holds a bare read verb with no noun after it, whatever it is called (review 2, N6; fix round 5)", () => {
    // A name that is only a verb says nothing about what it reads: "status", "get" or "read" on a trusted server could
    // read anything, so the name needs an object before it can pass.
    for (const name of ["get", "read", "status", "list", "check", "view", "show", "lookup", "describe", "inspect", "count", "find"])
      expect(toolEffect(name), name).not.toBe("read_only");
    for (const name of ["get_status", "read_issue", "list_branches"]) expect(toolEffect(name), name).toBe("read_only");
  });

  it("keeps the plain reads for a trusted server (fix round 2, item E)", () => {
    // The names the brief keeps passing: records are read by id, which cannot point anywhere else.
    for (const name of ["get_status", "list_issues", "list_pull_requests", "get_issue", "search_issues", "list_branches", "get_commit", "list_workflows"])
      expect(toolEffect(name), name).toBe("read_only");
  });

  it("holds every name it can't place, rather than calling it a read", () => {
    expect(toolEffect("frobnicate")).toBe("unknown");
    expect(toolEffect("frobnicate", "", { readOnlyHint: false })).toBe("unknown");
    expect(toolEffect("")).toBe("unknown");
    expect(toolEffect("  ", "")).not.toBe("read_only");
  });
});

// WP-101 review M2: these names are changes or joins, not reads, whatever their description says.
import { toolEffect as effectOf } from "./mcpEffect";
describe("names that are not reads (review M2)", () => {
  it.each(["list_item", "check_in", "check_by", "get_to", "view_on"])("does not read %s as a read", (name) => {
    expect(effectOf(name), name).not.toBe("read_only");
  });
});
