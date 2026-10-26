/* Adapted from agent-personal-memory. MIT, Copyright (c) 2026 Agent Personal Memory contributors. See LICENSE. */
import { normalize } from "./model.ts";
import type { Memory } from "./model.ts";

const generic = new Set([
  "用户",
  "如何",
  "什么",
  "一个",
  "这个",
  "建议",
  "问题",
  "现在",
  "可以",
  "应该",
  "关于",
  "进行",
  "the",
  "and",
  "for",
  "with",
  "how",
  "what",
  "should",
  "user",
]);
function terms(query: string): string[] {
  const words = query.normalize("NFKC").toLowerCase();
  const latin = (words.match(/[a-z0-9]+/g) || []).filter((word) => word.length >= 2);
  const han = (words.match(/[\p{Script=Han}]+/gu) || []).flatMap((word) =>
    word.length === 1
      ? [word]
      : Array.from(word)
          .slice(0, -1)
          .map((c, i) => c + word[i + 1]),
  );
  return [...new Set([...latin, ...han])].filter((word) => !generic.has(word));
}
export function searchMemories(memories: Memory[], query: string, limit = 12): Memory[] {
  const q = normalize(query);
  if (!q)
    return [...memories].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  const keys = terms(query);
  if (!keys.length) return [];
  return memories
    .map((m) => {
      const title = normalize(m.title),
        content = normalize(m.content),
        scope = normalize(m.scope),
        tags = normalize(m.tags.join(" "));
      const score =
        (title.includes(q) ? 40 : 0) +
        (content.includes(q) ? 15 : 0) +
        keys.reduce(
          (n, key) =>
            n +
            (title.includes(key) ? 8 : 0) +
            (tags.includes(key) ? 6 : 0) +
            (scope.includes(key) ? 5 : 0) +
            (content.includes(key) ? 3 : 0),
          0,
        );
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.m.updatedAt.localeCompare(a.m.updatedAt))
    .slice(0, limit)
    .map((x) => x.m);
}

// Normal conversations get only collaboration habits, never experiences/background/goals/ideas.
export function habitContext(memories: Memory[], budget = 3200): string {
  const habits = memories
    .filter(
      (m) =>
        m.type === "稳定偏好" &&
        m.certainty !== "探索中" &&
        /回答|沟通|协作|讨论|解释|输出|结论|步骤|简短|详细|做事|工作方式|小工具|编程|需求|coding|workflow|communication|collaboration|answer|response|habit/i.test(
          [m.title, m.content, m.scope, ...m.tags].join(" "),
        ),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const out: string[] = [];
  let size = 0;
  for (const m of habits) {
    const text = JSON.stringify({
      id: m.id,
      version: m.version,
      title: m.title,
      content: m.content,
      scope: m.scope,
      certainty: m.certainty,
    });
    if (size + text.length + (out.length ? 1 : 0) <= budget) {
      out.push(text);
      size += text.length + (out.length > 1 ? 1 : 0);
    }
  }
  return out.join("\n");
}
