#!/usr/bin/env -S lectic script

// Note: for Ink + React via esm.sh, it's easy to accidentally end up with
// multiple React copies (e.g. via differing query strings / versions), which
// causes runtime errors like "Minified React error #31".
//
// We intentionally use @latest here (per user request). To reduce the chance
// of React instance mismatch, keep all React-adjacent deps on the same
// resolver (esm.sh) and avoid mixing pinned + unpinned URLs.
import React, { useEffect, useMemo, useRef, useState }
  from "https://esm.sh/react@latest";
import { Box, Text, render, useApp, useInput, useStdout }
  from "https://esm.sh/ink@latest";
import Spinner from "https://esm.sh/ink-spinner@latest";
import Gradient from "https://esm.sh/ink-gradient@latest";
import ansiEscapes from "https://esm.sh/ansi-escapes@latest";

type AgentInfo = {
  agentId: string;
  name: string;
  description: string;
  cardUrl: string;
  monitoring: boolean;
};

type TurnTaskState = "submitted" | "working" | "completed" | "failed";

type TurnTaskSnapshot = {
  taskId: string;
  contextId: string;
  state: TurnTaskState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  userText: string;
  userMessageId: string;
  messageChunks: string[];
  agentMessageIds: string[];
  finalMessage: string;
  error?: string;
};

type MonitorAgentsResponse = {
  agents: AgentInfo[];
};

type MonitorTasksAllResponse = {
  agentId?: string;
  contextId?: string;
  agents: string[];
  contexts: string[];
  tasks: Array<TurnTaskSnapshot & { agentId: string }>;
};

type MonitorEvent = {
  ts: number;
  text: string;
};

type SsePayload =
  | {
    kind: "hello";
    agents: string[];
    agentId?: string;
    contextId?: string;
  }
  | {
    kind: "snapshot";
    agentId: string;
    snapshot: TurnTaskSnapshot;
  }
  | {
    kind: "event";
    agentId: string;
    event: {
      kind: "created" | "updated";
      snapshot: TurnTaskSnapshot;
      prevState?: TurnTaskState;
      stateChanged: boolean;
    };
  };

type View = "dashboard" | "taskHistory" | "contextHistory";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 41240;

function usage(): string {
  return [
    "Usage:",
    "  lectic a2a-monitor [options]",
    "",
    "Options:",
    "  --url <url>         Base URL (default http://127.0.0.1:41240)",
    "  --host <host>       Host (ignored if --url is set)",
    "  --port <port>       Port (ignored if --url is set)",
    "  --token <token>     Bearer token for protected monitoring endpoints",
    "  --agentId <id>      Filter server-side to a specific agent",
    "  --contextId <id>    Filter server-side to a specific context",
    "  --pollMs <ms>       Poll interval for /monitor/tasks (default 1500)",
    "  --no-sse            Disable the /monitor/events SSE stream",
    "  -h, --help          Show help",
    "",
    "Keys (dashboard):",
    "  ↑/↓        Select task",
    "  a          Cycle agent filter (client-side)",
    "  c          Cycle context filter (client-side)",
    "  Enter      View selected task message history",
    "  h          View selected context message history",
    "  r          Refresh now",
    "  m          Toggle markdown rendering",
    "  q / Ctrl+C Quit",
    "",
    "Keys (history view):",
    "  ↑/↓        Scroll",
    "  PgUp/PgDn  Scroll page",
    "  g/G        Top/bottom",
    "  m          Toggle markdown rendering",
    "  Esc / q    Back",
  ].join("\n");
}

function parseArgs(argv: string[]): {
  baseUrl: string;
  token?: string;
  agentId?: string;
  contextId?: string;
  pollMs: number;
  sse: boolean;
  help: boolean;
} {
  let url: string | undefined;
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let token = process.env["LECTIC_A2A_TOKEN"];
  let agentId: string | undefined;
  let contextId: string | undefined;
  let pollMs = 1500;
  let sse = true;
  let help = false;

  const next = (i: number): string => {
    const v = argv[i + 1];
    if (!v) throw new Error(`missing value for ${argv[i]}`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      help = true;
      continue;
    }

    if (a === "--url") {
      url = next(i);
      i++;
      continue;
    }

    if (a === "--host") {
      host = next(i);
      i++;
      continue;
    }

    if (a === "--port") {
      port = Number(next(i));
      if (!Number.isFinite(port)) {
        throw new Error("--port must be a number");
      }
      i++;
      continue;
    }

    if (a === "--token") {
      token = next(i);
      i++;
      continue;
    }

    if (a === "--agentId") {
      agentId = next(i);
      i++;
      continue;
    }

    if (a === "--contextId") {
      contextId = next(i);
      i++;
      continue;
    }

    if (a === "--pollMs") {
      pollMs = Number(next(i));
      if (!Number.isFinite(pollMs) || pollMs <= 0) {
        throw new Error("--pollMs must be a positive number");
      }
      i++;
      continue;
    }

    if (a === "--no-sse") {
      sse = false;
      continue;
    }

    throw new Error(`unknown arg: ${a}`);
  }

  const baseUrl = (url ?? `http://${host}:${port}`).replace(/\/+$/, "");

  return {
    baseUrl,
    token,
    agentId,
    contextId,
    pollMs,
    sse,
    help,
  };
}

function headersForToken(token?: string): HeadersInit {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function fetchJson<T>(url: string, token?: string): Promise<T> {
  const res = await fetch(url, { headers: headersForToken(token) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${res.status} ${res.statusText}${body ? `: ${body}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

function buildQuery(opt: { agentId?: string; contextId?: string }): string {
  const qs = new URLSearchParams();
  if (opt.agentId) qs.set("agentId", opt.agentId);
  if (opt.contextId) qs.set("contextId", opt.contextId);
  const s = qs.toString();
  return s ? `?${s}` : "";
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + "…";
}

function truncateKeep(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

function hardWrap(raw: string, width: number): string[] {
  const out: string[] = [];
  const w = Math.max(1, width);

  if (raw.length === 0) {
    return [""];
  }

  for (let i = 0; i < raw.length; i += w) {
    out.push(raw.slice(i, i + w));
  }

  return out;
}

function wrapText(s: string, width: number): string[] {
  const out: string[] = [];
  const w = Math.max(1, width);
  const lines = s.replace(/\r\n/g, "\n").split("\n");

  for (const raw of lines) {
    if (raw === "") {
      out.push("");
      continue;
    }

    // Preserve indentation and any preformatted-ish lines.
    if (raw.startsWith("```") || /^( {4}|\t)/.test(raw)) {
      out.push(...hardWrap(raw, w));
      continue;
    }

    const m = raw.match(/^(\s*)(.*)$/);
    const indent = m?.[1] ?? "";
    const body = m?.[2] ?? raw;

    const words = body.split(/\s+/).filter(Boolean);

    if (words.length === 0) {
      out.push("");
      continue;
    }

    let cur = indent + words[0];

    for (const word of words.slice(1)) {
      const next = `${cur} ${word}`;
      if (next.length <= w) {
        cur = next;
        continue;
      }

      out.push(cur);
      cur = indent + word;

      if (cur.length > w) {
        out.push(...hardWrap(cur, w));
        cur = "";
      }
    }

    if (cur) out.push(cur);
  }

  return out;
}

function wrapTextRaw(s: string, width: number): string[] {
  const out: string[] = [];
  const w = Math.max(1, width);
  const lines = s.replace(/\r\n/g, "\n").split("\n");

  for (const raw of lines) {
    if (raw === "") {
      out.push("");
      continue;
    }

    out.push(...hardWrap(raw, w));
  }

  return out;
}

function indentLines(lines: string[], prefix: string): string[] {
  return lines.map((l) => (l ? `${prefix}${l}` : prefix.trimEnd()));
}

function parseIsoMs(iso?: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function formatSince(iso: string, now: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  return formatDuration(now - ms);
}

function stateColor(state: TurnTaskState): string {
  switch (state) {
    case "completed":
      return "green";
    case "working":
      return "yellow";
    case "failed":
      return "red";
    default:
      return "gray";
  }
}

function renderState(state: TurnTaskState): React.ReactNode {
  if (state === "working") {
    return (
      <Text color={stateColor(state)}>
        <Spinner type="dots" /> {state}
      </Text>
    );
  }

  return <Text color={stateColor(state)}>{state}</Text>;
}

async function readSse(
  url: string,
  opt: {
    token?: string;
    signal: AbortSignal;
    onPayload: (p: SsePayload) => void;
  },
): Promise<void> {
  const res = await fetch(url, {
    headers: headersForToken(opt.token),
    signal: opt.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `SSE failed: ${res.status} ${res.statusText}${body ? `: ${body}` : ""}`,
    );
  }

  const body = res.body;
  if (!body) {
    throw new Error("SSE response had no body");
  }

  const reader = body.getReader();
  const dec = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;

    buffer += dec.decode(value, { stream: true });

    while (true) {
      const idx = buffer.indexOf("\n\n");
      if (idx < 0) break;

      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const dataLines = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"));

      if (dataLines.length === 0) continue;

      const jsonText = dataLines
        .map((l) => l.slice("data:".length).trim())
        .join("\n");

      if (!jsonText) continue;

      try {
        const parsed = JSON.parse(jsonText) as SsePayload;
        opt.onPayload(parsed);
      } catch {
        // Ignore malformed events.
      }
    }
  }
}

type InlineSpanKind = "plain" | "code" | "bold";

type InlineSpan = {
  kind: InlineSpanKind;
  text: string;
};

function parseMarkdownInline(s: string): InlineSpan[] {
  const out: InlineSpan[] = [];

  const push = (kind: InlineSpanKind, text: string) => {
    if (!text) return;
    out.push({ kind, text });
  };

  let i = 0;

  while (i < s.length) {
    const idxCode = s.indexOf("`", i);
    const idxBold = s.indexOf("**", i);

    let idx = -1;
    let kind: InlineSpanKind | null = null;

    if (idxCode >= 0 && (idxBold < 0 || idxCode < idxBold)) {
      idx = idxCode;
      kind = "code";
    } else if (idxBold >= 0) {
      idx = idxBold;
      kind = "bold";
    }

    if (idx < 0 || !kind) {
      push("plain", s.slice(i));
      break;
    }

    if (idx > i) {
      push("plain", s.slice(i, idx));
    }

    if (kind === "code") {
      const end = s.indexOf("`", idx + 1);
      if (end < 0) {
        push("plain", s.slice(idx));
        break;
      }

      push("code", s.slice(idx + 1, end));
      i = end + 1;
      continue;
    }

    const end = s.indexOf("**", idx + 2);
    if (end < 0) {
      push("plain", s.slice(idx));
      break;
    }

    push("bold", s.slice(idx + 2, end));
    i = end + 2;
  }

  return out;
}

function renderMarkdownHistoryLine(
  line: string,
  key: number,
): React.ReactNode {
  if (line === "") {
    return <Text key={key}> </Text>;
  }

  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    return (
      <Text key={key} bold color="cyan">
        {heading[2] || " "}
      </Text>
    );
  }

  if (line.startsWith("```")) {
    return (
      <Text key={key} dimColor>
        {line}
      </Text>
    );
  }

  const quote = line.match(/^>\s?(.*)$/);
  if (quote) {
    return (
      <Text key={key} dimColor>
        {quote[1] || " "}
      </Text>
    );
  }

  const spans = parseMarkdownInline(line);

  if (spans.length === 0) {
    return <Text key={key}> </Text>;
  }

  return (
    <Text key={key}>
      {spans.map((sp, idx) => {
        if (sp.kind === "code") {
          return (
            <Text key={idx} color="yellow">
              {sp.text}
            </Text>
          );
        }

        if (sp.kind === "bold") {
          return (
            <Text key={idx} bold>
              {sp.text}
            </Text>
          );
        }

        return <Text key={idx}>{sp.text}</Text>;
      })}
    </Text>
  );
}

function renderHistoryLine(
  line: string,
  key: number,
  width: number,
  markdown: boolean,
): React.ReactNode {
  const t = truncateKeep(line, width);

  if (t === "") {
    return <Text key={key}> </Text>;
  }

  if (!markdown) {
    return <Text key={key}>{t}</Text>;
  }

  return renderMarkdownHistoryLine(t, key);
}

function historyInnerHeight(height: number, subtitle?: string): number {
  const headerHeight = subtitle ? 2 : 1;
  const footerHeight = 1;
  const borderHeight = 2;

  return clamp(height - headerHeight - footerHeight - borderHeight, 1, height);
}

function HistoryView(props: {
  title: string;
  subtitle?: string;
  lines: string[];
  width: number;
  height: number;
  scrollTop: number;
  markdown: boolean;
}): React.ReactNode {
  const borderHeight = 2;

  const innerHeight = historyInnerHeight(props.height, props.subtitle);
  const boxHeight = innerHeight + borderHeight;

  const maxScrollTop = Math.max(0, props.lines.length - innerHeight);
  const scrollTop = clamp(props.scrollTop, 0, maxScrollTop);

  const visible = props.lines.slice(scrollTop, scrollTop + innerHeight);

  const pad = innerHeight - visible.length;
  for (let i = 0; i < pad; i++) visible.push("");

  const start = props.lines.length === 0 ? 0 : scrollTop + 1;
  const end = Math.min(props.lines.length, scrollTop + innerHeight);
  const scrollInfo = props.lines.length === 0
    ? "0/0"
    : `${start}-${end}/${props.lines.length}`;

  const md = props.markdown ? "on" : "off";

  return (
    <Box flexDirection="column" width={props.width} height={props.height}>
      <Text bold>{truncate(props.title, props.width)}</Text>
      {props.subtitle ? (
        <Text dimColor>{truncate(props.subtitle, props.width)}</Text>
      ) : null}

      <Box
        flexDirection="column"
        borderStyle="round"
        paddingX={1}
        height={boxHeight}
      >
        {visible.map((l, idx) => {
          return renderHistoryLine(l, idx, props.width - 4, props.markdown);
        })}
      </Box>

      <Text dimColor>
        ↑/↓ scroll  PgUp/PgDn page  g/G top/bot  m md={md}  Esc/q back  ({
          scrollInfo
        })
      </Text>
    </Box>
  );
}

function buildTaskHistoryLines(
  t: TurnTaskSnapshot & { agentId: string },
  width: number,
): string[] {
  const out: string[] = [];

  out.push(`agent: ${t.agentId}`);
  out.push(`context: ${t.contextId}`);
  out.push(`taskId: ${t.taskId}`);
  out.push(`state: ${t.state}`);
  out.push("");

  out.push("User:");
  out.push(...indentLines(wrapText(t.userText, width), "  "));
  out.push("");

  if (t.error) {
    out.push("Error:");
    out.push(...indentLines(wrapText(t.error, width), "  "));
    out.push("");
  }

  out.push("Agent message chunks:");

  if (t.messageChunks.length === 0) {
    out.push("  (none yet)");
    return out;
  }

  const total = t.messageChunks.length;

  for (let i = 0; i < t.messageChunks.length; i++) {
    const hdr = `  --- chunk ${i + 1}/${total} ---`;
    out.push(hdr);
    out.push(...indentLines(wrapTextRaw(t.messageChunks[i] ?? "", width), "  "));
    out.push("");
  }

  return out;
}

function buildContextHistoryLines(
  opt: {
    contextId: string;
    tasks: Array<TurnTaskSnapshot & { agentId: string }>;
  },
  width: number,
): string[] {
  const out: string[] = [];

  const tasks = opt.tasks
    .filter((t) => t.contextId === opt.contextId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  out.push(`context: ${opt.contextId}`);
  out.push(`turns: ${tasks.length}`);
  out.push("");

  if (tasks.length === 0) {
    out.push("(no tasks)");
    return out;
  }

  for (const t of tasks) {
    out.push(
      `[${truncate(t.agentId, 18)}] ${shortId(t.taskId)}  ${t.state}`,
    );

    out.push("  user:");
    out.push(...indentLines(wrapText(t.userText, width), "    "));

    if (t.error) {
      out.push("  error:");
      out.push(...indentLines(wrapText(t.error, width), "    "));
    } else if (t.finalMessage) {
      out.push("  final:");
      out.push(...indentLines(wrapText(t.finalMessage, width), "    "));
    } else {
      out.push("  final:");
      out.push("    (none yet)");
    }

    out.push("");
  }

  return out;
}

function App(props: {
  baseUrl: string;
  token?: string;
  serverAgentId?: string;
  serverContextId?: string;
  pollMs: number;
  sse: boolean;
}): React.ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const width = stdout.columns ?? 80;
  const height = stdout.rows ?? 30;

  const [view, setView] = useState<View>("dashboard");
  const [scrollTop, setScrollTop] = useState(0);
  const [markdown, setMarkdown] = useState(false);

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [tasks, setTasks] = useState<Array<TurnTaskSnapshot & { agentId: string }>>(
    [],
  );
  const [contexts, setContexts] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const [agentFilterIdx, setAgentFilterIdx] = useState(-1);
  const [contextFilterIdx, setContextFilterIdx] = useState(-1);

  const [lastError, setLastError] = useState<string | null>(null);
  const [lastFetchMs, setLastFetchMs] = useState<number | null>(null);
  const [sseConnected, setSseConnected] = useState(false);

  const [events, setEvents] = useState<MonitorEvent[]>([]);

  const refreshRef = useRef<() => void>(() => undefined);

  const now = Date.now();

  const visibleAgents = useMemo(() => {
    if (agents.length === 0) return [];
    return agents;
  }, [agents]);

  const agentFilterId = useMemo(() => {
    if (agentFilterIdx < 0) return undefined;
    return visibleAgents[agentFilterIdx]?.agentId;
  }, [agentFilterIdx, visibleAgents]);

  const contextFilterId = useMemo(() => {
    if (contextFilterIdx < 0) return undefined;
    return contexts[contextFilterIdx];
  }, [contextFilterIdx, contexts]);

  const filteredTasks = useMemo(() => {
    let out = tasks;
    if (agentFilterId) {
      out = out.filter((t) => t.agentId === agentFilterId);
    }
    if (contextFilterId) {
      out = out.filter((t) => t.contextId === contextFilterId);
    }

    return [...out].sort((a, b) => {
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
  }, [tasks, agentFilterId, contextFilterId]);

  const selectedTask = filteredTasks[selectedIndex];

  const history = useMemo(() => {
    const innerWidth = Math.max(20, width - 6);

    if (view === "taskHistory" && selectedTask) {
      return {
        title: `Task history (${shortId(selectedTask.taskId)})`,
        subtitle: `${selectedTask.agentId} / ${selectedTask.contextId}`,
        lines: buildTaskHistoryLines(selectedTask, innerWidth),
      };
    }

    if (view === "contextHistory" && selectedTask) {
      const cid = selectedTask.contextId;

      const baseTasks = agentFilterId
        ? tasks.filter((t) => t.agentId === agentFilterId)
        : tasks;

      return {
        title: `Context history (${truncate(cid, 30)})`,
        subtitle: agentFilterId ? `agent filter: ${agentFilterId}` : undefined,
        lines: buildContextHistoryLines(
          { contextId: cid, tasks: baseTasks },
          innerWidth,
        ),
      };
    }

    return null;
  }, [view, selectedTask, tasks, width, agentFilterId]);

  useEffect(() => {
    if (!history) return;

    const max = Math.max(
      0,
      history.lines.length - historyInnerHeight(height, history.subtitle),
    );

    setScrollTop((s) => clamp(s, 0, max));
  }, [history, height]);

  useEffect(() => {
    setAgentFilterIdx((i) => {
      return i >= visibleAgents.length ? -1 : i;
    });
  }, [visibleAgents.length]);

  useEffect(() => {
    setContextFilterIdx((i) => {
      return i >= contexts.length ? -1 : i;
    });
  }, [contexts.length]);

  useEffect(() => {
    setSelectedIndex((i) => {
      const max = Math.max(0, filteredTasks.length - 1);
      return clamp(i, 0, max);
    });
  }, [filteredTasks.length]);

  const rows = height;

  const taskWindow = clamp(rows - 20, 6, Math.max(6, rows - 8));
  const taskStart = clamp(
    selectedIndex - Math.floor(taskWindow / 2),
    0,
    Math.max(0, filteredTasks.length - taskWindow),
  );
  const visibleTasksList = filteredTasks.slice(taskStart, taskStart + taskWindow);

  const maxEvents = Math.max(5, rows - 18);

  const addEvent = (text: string) => {
    setEvents((prev) => {
      const next = [...prev, { ts: Date.now(), text }];
      return next.slice(-maxEvents);
    });
  };

  const refreshNow = async () => {
    try {
      setLastError(null);

      const agentsRes = await fetchJson<MonitorAgentsResponse>(
        `${props.baseUrl}/monitor/agents`,
        props.token,
      );

      setAgents(agentsRes.agents);

      const tasksRes = await fetchJson<MonitorTasksAllResponse>(
        `${props.baseUrl}/monitor/tasks${buildQuery({
          agentId: props.serverAgentId,
          contextId: props.serverContextId,
        })}`,
        props.token,
      );

      setContexts(tasksRes.contexts);
      setTasks(tasksRes.tasks);

      setLastFetchMs(Date.now());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(msg);
    }
  };

  refreshRef.current = () => {
    void refreshNow();
  };

  useEffect(() => {
    void refreshNow();

    const t = setInterval(() => {
      void refreshNow();
    }, props.pollMs);

    return () => clearInterval(t);
  }, [
    props.baseUrl,
    props.token,
    props.pollMs,
    props.serverAgentId,
    props.serverContextId,
  ]);

  useEffect(() => {
    if (!props.sse) {
      setSseConnected(false);
      return;
    }

    const sseUrl = `${props.baseUrl}/monitor/events${buildQuery({
      agentId: props.serverAgentId,
      contextId: props.serverContextId,
    })}`;

    let stopped = false;
    const ac = new AbortController();

    const loop = async () => {
      let attempt = 0;

      while (!stopped) {
        try {
          setSseConnected(false);

          await readSse(sseUrl, {
            token: props.token,
            signal: ac.signal,
            onPayload(p) {
              if (p.kind === "event") {
                const t = p.event.snapshot;

                setTasks((prev) => {
                  const next = [...prev];
                  const i = next.findIndex((x) => x.taskId === t.taskId);
                  const withAgent = { agentId: p.agentId, ...t };
                  if (i >= 0) next[i] = withAgent;
                  else next.push(withAgent);
                  return next;
                });

                addEvent(
                  `${p.agentId} ${p.event.kind} `
                    + `${shortId(t.taskId)} ${t.state}`,
                );
              }

              if (p.kind === "snapshot") {
                setTasks((prev) => {
                  const next = [...prev];
                  const i = next.findIndex((x) => x.taskId === p.snapshot.taskId);
                  const withAgent = { agentId: p.agentId, ...p.snapshot };
                  if (i >= 0) next[i] = withAgent;
                  else next.push(withAgent);
                  return next;
                });
              }

              if (p.kind === "hello") {
                setSseConnected(true);
                addEvent(
                  `connected (agents: ${p.agents.length}, `
                    + `filter: ${p.agentId ?? "*"}/${p.contextId ?? "*"})`,
                );
              }
            },
          });

          if (!stopped) {
            throw new Error("SSE stream ended");
          }
        } catch (e) {
          if (stopped) return;

          const msg = e instanceof Error ? e.message : String(e);
          setLastError(msg);

          const backoff = Math.min(5000, 250 * 2 ** attempt);
          attempt = Math.min(attempt + 1, 6);

          addEvent(`sse error, retrying in ${backoff}ms: ${msg}`);

          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    };

    void loop();

    return () => {
      stopped = true;
      ac.abort();
    };
  }, [
    props.baseUrl,
    props.token,
    props.sse,
    props.serverAgentId,
    props.serverContextId,
  ]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    if (view !== "dashboard") {
      if (input === "q" || key.escape) {
        setView("dashboard");
        setScrollTop(0);
        return;
      }

      if (input === "m") {
        setMarkdown((m) => !m);
        return;
      }

      if (!history) {
        return;
      }

      const innerHeight = historyInnerHeight(height, history.subtitle);
      const max = Math.max(0, history.lines.length - innerHeight);
      const page = Math.max(1, innerHeight - 1);

      if (key.upArrow) {
        setScrollTop((s) => clamp(s - 1, 0, max));
        return;
      }

      if (key.downArrow) {
        setScrollTop((s) => clamp(s + 1, 0, max));
        return;
      }

      if (key.pageUp) {
        setScrollTop((s) => clamp(s - page, 0, max));
        return;
      }

      if (key.pageDown) {
        setScrollTop((s) => clamp(s + page, 0, max));
        return;
      }

      if (input === "g") {
        setScrollTop(0);
        return;
      }

      if (input === "G") {
        setScrollTop(max);
        return;
      }

      return;
    }

    if (input === "q") {
      exit();
      return;
    }

    if (input === "m") {
      setMarkdown((m) => !m);
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => {
        return clamp(i - 1, 0, Math.max(0, filteredTasks.length - 1));
      });
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((i) => {
        return clamp(i + 1, 0, Math.max(0, filteredTasks.length - 1));
      });
      return;
    }

    if (key.return) {
      if (!selectedTask) return;
      setView("taskHistory");
      setScrollTop(0);
      return;
    }

    if (input === "h") {
      if (!selectedTask) return;
      setView("contextHistory");
      setScrollTop(0);
      return;
    }

    if (input === "r") {
      refreshRef.current();
      return;
    }

    if (input === "a") {
      setAgentFilterIdx((i) => {
        if (visibleAgents.length === 0) return -1;
        const next = i + 1;
        return next >= visibleAgents.length ? -1 : next;
      });
      setSelectedIndex(0);
      return;
    }

    if (input === "c") {
      setContextFilterIdx((i) => {
        if (contexts.length === 0) return -1;
        const next = i + 1;
        return next >= contexts.length ? -1 : next;
      });
      setSelectedIndex(0);
      return;
    }
  });

  if (history) {
    return (
      <HistoryView
        title={history.title}
        subtitle={history.subtitle}
        lines={history.lines}
        width={width}
        height={height}
        scrollTop={scrollTop}
        markdown={markdown}
      />
    );
  }

  const header = (
    <Box flexDirection="column" marginBottom={1}>
      <Gradient name="cristal">
        <Text>A2A monitor</Text>
      </Gradient>
      <Text dimColor>
        {props.baseUrl}
        {props.serverAgentId ? `  agentId=${props.serverAgentId}` : ""}
        {props.serverContextId ? `  contextId=${props.serverContextId}` : ""}
        {props.token ? "  auth=on" : "  auth=off"}
      </Text>
    </Box>
  );

  const pollState = lastFetchMs ? "ok" : "starting";
  const sseState = !props.sse ? "off" : sseConnected ? "ok" : "reconnect";

  const summary = (
    <Box marginBottom={1}>
      <Box width={14}>
        <Text>
          <Text bold>poll</Text> {pollState}
        </Text>
      </Box>
      <Box width={16}>
        <Text>
          <Text bold>sse</Text> {sseState}
        </Text>
      </Box>
      <Box width={18}>
        <Text>
          <Text bold>last</Text>{" "}
          {lastFetchMs
            ? formatSince(new Date(lastFetchMs).toISOString(), now)
            : "-"}
        </Text>
      </Box>
      <Box width={14}>
        <Text>
          <Text bold>agents</Text> {agents.length}
        </Text>
      </Box>
      <Box width={14}>
        <Text>
          <Text bold>tasks</Text> {tasks.length}
        </Text>
      </Box>
    </Box>
  );

  const errorLine = lastError ? (
    <Box marginBottom={1}>
      <Text color="red">error: {truncate(lastError, width - 7)}</Text>
    </Box>
  ) : null;

  const filterLine = (
    <Box marginBottom={1}>
      <Text>
        <Text bold>Filters:</Text>
        <Text> agent=</Text>
        <Text color="cyan">{agentFilterId ?? "*"}</Text>
        <Text>  context=</Text>
        <Text color="cyan">{contextFilterId ?? "*"}</Text>
      </Text>
    </Box>
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      {header}
      {summary}
      {errorLine}
      {filterLine}

      <Box flexDirection="row" gap={2} flexGrow={1}>
        <Box flexDirection="column" width={26}>
          <Text bold>Agents</Text>
          <Box flexDirection="column">
            <Text color={agentFilterIdx < 0 ? "cyan" : "gray"}>
              {agentFilterIdx < 0 ? "> " : "  "}*
            </Text>
            {visibleAgents.map((a, idx) => {
              const selected = idx === agentFilterIdx;
              const label = truncate(a.agentId, 20);
              const monitorTag = a.monitoring ? "" : " (no mon)";

              return (
                <Text key={a.agentId} color={selected ? "cyan" : "white"}>
                  {selected ? "> " : "  "}{label}{monitorTag}
                </Text>
              );
            })}
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text bold>Contexts</Text>
            <Text color={contextFilterIdx < 0 ? "cyan" : "gray"}>
              {contextFilterIdx < 0 ? "> " : "  "}*
            </Text>
            {contexts.slice(0, 8).map((cid, idx) => {
              const selected = idx === contextFilterIdx;
              return (
                <Text key={cid} color={selected ? "cyan" : "white"}>
                  {selected ? "> " : "  "}{truncate(cid, 20)}
                </Text>
              );
            })}
            {contexts.length > 8 ? (
              <Text dimColor>… ({contexts.length - 8} more)</Text>
            ) : null}
          </Box>
        </Box>

        <Box flexDirection="column" flexGrow={1}>
          <Text bold>Tasks (updated desc)</Text>

          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            {filteredTasks.length === 0 ? (
              <Text dimColor>(no tasks)</Text>
            ) : null}

            {taskStart > 0 ? (
              <Text dimColor>↑ ({taskStart} above)</Text>
            ) : null}

            {visibleTasksList.map((t, localIdx) => {
              const idx = taskStart + localIdx;
              const selected = idx === selectedIndex;
              const prefix = selected ? ">" : " ";

              const age = formatSince(t.createdAt, now);
              const state = renderState(t.state);

              const msg = truncate(t.userText, 30);

              return (
                <Text key={t.taskId}>
                  <Text color={selected ? "cyan" : "gray"}>{prefix}</Text>
                  <Text> </Text>
                  <Text color="magenta">{truncate(t.agentId, 10)}</Text>
                  <Text> </Text>
                  <Text color="blue">{truncate(t.contextId, 10)}</Text>
                  <Text> </Text>
                  <Text>{shortId(t.taskId)}</Text>
                  <Text> </Text>
                  {state}
                  <Text> </Text>
                  <Text dimColor>{age}</Text>
                  <Text> </Text>
                  <Text>{msg}</Text>
                </Text>
              );
            })}

            {taskStart + visibleTasksList.length < filteredTasks.length ? (
              <Text dimColor>
                ↓ ({filteredTasks.length - (taskStart + visibleTasksList.length)}
                {" "}below)
              </Text>
            ) : null}
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text bold>Selected task</Text>
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              {!selectedTask ? (
                <Text dimColor>(none)</Text>
              ) : (
                <>
                  <Text>
                    <Text dimColor>agent</Text> {selectedTask.agentId}  
                    <Text dimColor>context</Text> {selectedTask.contextId}
                  </Text>
                  <Text>
                    <Text dimColor>taskId</Text> {selectedTask.taskId}
                  </Text>
                  <Text>
                    <Text dimColor>state</Text> {renderState(selectedTask.state)}
                    <Text>  </Text>
                    <Text dimColor>age</Text> {formatSince(selectedTask.createdAt, now)}
                  </Text>
                  {selectedTask.startedAt ? (
                    <Text>
                      <Text dimColor>duration</Text>{" "}
                      {formatDuration(
                        (parseIsoMs(selectedTask.endedAt) ?? now)
                          - (parseIsoMs(selectedTask.startedAt) ?? now),
                      )}
                    </Text>
                  ) : null}
                  {selectedTask.error ? (
                    <Text color="red">
                      error: {truncate(selectedTask.error, width - 12)}
                    </Text>
                  ) : null}
                  <Text>
                    <Text dimColor>user</Text>{" "}
                    {truncate(selectedTask.userText, width - 8)}
                  </Text>
                  {selectedTask.finalMessage ? (
                    <Text>
                      <Text dimColor>final</Text>{" "}
                      {truncate(selectedTask.finalMessage, width - 9)}
                    </Text>
                  ) : null}
                </>
              )}
            </Box>
          </Box>

          <Box marginTop={1} flexDirection="column" flexGrow={1}>
            <Text bold>Events</Text>
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              {events.length === 0 ? <Text dimColor>(no events yet)</Text> : null}
              {events.map((e, idx) => {
                const t = new Date(e.ts).toISOString().slice(11, 19);
                return (
                  <Text key={`${e.ts}-${idx}`} dimColor>
                    {t} {truncate(e.text, width - 12)}
                  </Text>
                );
              })}
            </Box>
          </Box>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          keys: ↑/↓ select  a agent  c context  enter task  h context  r refresh
          {" "}m markdown  q quit
        </Text>
      </Box>
    </Box>
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`error: ${msg}`);
    console.error(usage());
    process.exit(1);
  }

  if (args.help) {
    console.log(usage());
    return;
  }

  const stdout = process.stdout;
  const useAlt = Boolean(stdout.isTTY);

  if (useAlt) {
    stdout.write(ansiEscapes.enterAlternativeScreen);
    stdout.write(ansiEscapes.clearScreen);
    stdout.write(ansiEscapes.cursorHide);
  }

  try {
    const { waitUntilExit } = render(
      <App
        baseUrl={args.baseUrl}
        token={args.token}
        serverAgentId={args.agentId}
        serverContextId={args.contextId}
        pollMs={args.pollMs}
        sse={args.sse}
      />,
      { exitOnCtrlC: false },
    );

    await waitUntilExit();
  } finally {
    if (useAlt) {
      stdout.write(ansiEscapes.cursorShow);
      stdout.write(ansiEscapes.exitAlternativeScreen);
    }
  }
}

export default main;
