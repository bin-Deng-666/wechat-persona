/* Adapted from agent-personal-memory. MIT, Copyright (c) 2026 Agent Personal Memory contributors. See LICENSE. */
import { createHash } from "node:crypto";

export const TYPES = ["个人背景", "个人经历", "目标与方向", "观点与想法", "稳定偏好"] as const;
export type MemoryType = (typeof TYPES)[number];
export const TYPE_LABELS: Record<MemoryType, string> = {
  个人背景: "Background",
  个人经历: "Experiences",
  目标与方向: "Goals & direction",
  观点与想法: "Ideas & insights",
  稳定偏好: "Preferences",
};
export const TYPE_FILES: Record<MemoryType, string> = {
  个人背景: "background.json",
  个人经历: "experiences.json",
  目标与方向: "goals.json",
  观点与想法: "ideas.json",
  稳定偏好: "preferences.json",
};
export const CERTAINTY_LABELS = {
  明确: "Established",
  当前倾向: "Current inclination",
  探索中: "Exploring",
} as const;
export interface Source {
  /** Optional historical origin; retained so stored source keys remain stable. */
  host?: string;
  sessionId: string;
  entryId: string;
  fingerprint: string;
  quote: string;
  timestamp: string;
}
export interface Memory {
  id: string;
  version: number;
  title: string;
  content: string;
  type: MemoryType;
  scope: string;
  certainty: keyof typeof CERTAINTY_LABELS;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  sources: Source[];
}
export interface Proposal {
  action: "add" | "update" | "delete";
  targetId?: string;
  targetVersion?: number;
  title: string;
  content: string;
  type: MemoryType;
  scope: string;
  certainty: Memory["certainty"];
  tags: string[];
  reason: string;
  origin: "automatic" | "explicit" | "history" | "manual";
  sources: Source[];
}
export interface Scan {
  entries: Record<string, string>;
  completedAt: string;
  candidates: number;
}
export interface State {
  schemaVersion: 1;
  memories: Memory[];
  suppressed: string[];
  scans: Record<string, Scan>;
}
export interface Settings {
  enabled: boolean;
}
export const emptyState = (): State => ({
  schemaVersion: 1,
  memories: [],
  suppressed: [],
  scans: {},
});
export function createProposal(extra: Partial<Proposal>): Proposal {
  return {
    action: "add",
    title: "",
    content: "",
    type: "观点与想法",
    scope: "",
    certainty: "明确",
    tags: [],
    reason: "Manually managed by the user",
    origin: "manual",
    sources: [],
    ...extra,
  };
}
export const memoryFields = (m: Pick<Memory, 'title' | 'content' | 'type' | 'scope' | 'certainty' | 'tags'>) => ({
  title: m.title,
  content: m.content,
  type: m.type,
  scope: m.scope,
  certainty: m.certainty,
  tags: m.tags,
});
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, "");
export const contentKey = (content: string) => `content:${digest(normalize(content))}`;
export const sourceKey = (source: Source) =>
  `source:${source.host && source.host !== "pi" ? `${source.host}:` : ""}${source.entryId}:${source.fingerprint}:${digest(normalize(source.quote))}`;
export const proposalKeys = (p: Pick<Proposal, "content" | "sources">) => [
  contentKey(p.content),
  ...p.sources.map(sourceKey),
];
export const isLongTermChange = (text: string) =>
  /(记错|纠正|不再(?:认同|喜欢|偏好|打算|想要|追求|考虑|从事|使用)|(?:现在|以后).{0,12}(?:决定|更喜欢|偏好|改为)|以前.{0,40}现在|\b(?:i no longer|i now prefer|i have decided|correction|that was wrong)\b)/iu.test(
    text,
  );
export function isDuplicate(
  state: State,
  p: Pick<Proposal, "content" | "sources">,
  excluding?: string,
) {
  const keys = proposalKeys(p);
  return (
    keys.some((k) => state.suppressed.includes(k)) ||
    state.memories.some((m) => m.id !== excluding && normalize(m.content) === normalize(p.content))
  );
}
export function validateProposal(p: Proposal) {
  if (!["add", "update", "delete"].includes(p.action) || !TYPES.includes(p.type))
    throw new Error("Invalid memory action or type");
  if (
    typeof p.content !== "string" ||
    !p.content.trim() ||
    p.content.length > 6000 ||
    typeof p.title !== "string" ||
    !p.title.trim() ||
    p.title.length > 160
  )
    throw new Error("Provide a title (up to 160 characters) and content (up to 6000 characters)");
  if (typeof p.reason !== "string" || !p.reason.trim())
    throw new Error("Explain the concrete future value or reason for this change");
  if (
    typeof p.scope !== "string" ||
    p.scope.length > 2000 ||
    !Array.isArray(p.tags) ||
    p.tags.length > 12 ||
    p.tags.some((t) => typeof t !== "string" || t.length > 100)
  )
    throw new Error("Invalid scope or tags");
  if (!["明确", "当前倾向", "探索中"].includes(p.certainty)) throw new Error("Invalid certainty");
  if (
    p.action !== "add" &&
    (!p.targetId || !Number.isInteger(p.targetVersion) || p.targetVersion! < 1)
  )
    throw new Error("Updates and deletions require the retrieved ID and version");
}
export function validateState(value: State) {
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.memories) ||
    !Array.isArray(value.suppressed) ||
    !value.scans ||
    typeof value.scans !== "object"
  )
    throw new Error("Unsupported memory file format; file was preserved");
  const ids = new Set<string>();
  for (const m of value.memories) {
    if (
      !m.id ||
      ids.has(m.id) ||
      !Number.isInteger(m.version) ||
      m.version < 1 ||
      !TYPES.includes(m.type) ||
      typeof m.content !== "string" ||
      !Array.isArray(m.sources) ||
      !Array.isArray(m.tags) ||
      typeof m.title !== "string" ||
      typeof m.scope !== "string" ||
      !Object.hasOwn(CERTAINTY_LABELS, m.certainty)
    )
      throw new Error("Invalid memory record; file was preserved");
    ids.add(m.id);
    for (const s of m.sources)
      if (
        ![s.sessionId, s.entryId, s.fingerprint, s.quote, s.timestamp].every(
          (x) => typeof x === "string",
        )
      )
        throw new Error("Invalid memory source; file was preserved");
  }
}
