/* Adapted from agent-personal-memory. MIT, Copyright (c) 2026 Agent Personal Memory contributors. See LICENSE. */
import type { Proposal } from "./model.ts";

/** Deterministic guards catch obvious failures; semantic value/fidelity still need model review. */
export function validatePersonalEvidence(proposal: Proposal) {
  if (proposal.action === "delete" || !proposal.sources.length) return;
  const evidence = proposal.sources.map((source) => source.quote).join("\n");
  const summary = `${proposal.title}\n${proposal.content}\n${proposal.scope}`;
  const compact = evidence.replace(/\s+/g, "");
  for (const identifier of summary.match(
    /\b(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[a-z0-9_./?=%&#-]*)?/gi,
  ) || []) {
    const plain = identifier
      .replace(/^https?:\/\//i, "")
      .replace(/\/$/, "")
      .toLowerCase();
    if (!evidence.toLowerCase().includes(plain))
      throw new Error("The summary names a service/domain absent from its quoted user evidence");
  }
  const characterClaim =
    /谨慎程度|考虑全面|性格.{0,6}(?:谨慎|理性|焦虑)|追求完美|完美主义|害怕失败|抗压能力|风险厌恶|\b(?:perfectionist|risk.averse|personality|fears? failure)\b/iu;
  if (characterClaim.test(summary) && !characterClaim.test(evidence))
    throw new Error(
      "A situational choice cannot establish a personality, motive or character claim",
    );

  const personalStatement =
    /(?:我|本人|自己).{0,24}(?:职业|家庭|照顾|工作环境|只能.{0,8}办公|内网.{0,8}(?:办公|工作)|经历|感到|觉得|焦虑|挫败|难过|自豪|担心|转行|辞职)|(?:让我|使我|我当时).{0,12}(?:感到|觉得|焦虑|挫败|难过|自豪|担心)|\b(?:i work offline|i (?:work|live|care for|felt|experienced)|my (?:career|family|working conditions))\b/iu.test(
      evidence,
    );
  const temporaryFailure =
    /有时(?:候)?.{0,12}(?:连得上|连不上|连接|网络)|这次.{0,12}(?:报错|连接失败|超时)|\b(?:sometimes connects|intermittent connection|this timeout)\b/iu.test(
      evidence,
    );
  if (proposal.type === "个人背景" && temporaryFailure && !personalStatement)
    throw new Error("A troubleshooting observation does not establish ongoing personal background");

  const taskInstruction =
    /(?:这个|本次|该|当前|我们的).{0,6}(?:项目|仓库|插件|页面|功能|任务)|(?:数据层|回测|webui|界面|页面|按钮|模块|代码|文件|接口|安装包|readme|仓库|插件|策略类).{0,32}(?:重构|更新|优化|复用|设计|改|拆|支持|上传|命名)|(?:改|重构|优化|复用|设计|更新).{0,24}(?:数据层|回测|webui|模块|代码|接口)|(?:下一环节|下一阶段).{0,24}(?:改|做|开发)|(?:不定时|增量).{0,20}(?:更新|补|拉取)|(?:不上传|不要上传|不要暴露|只留|只上传).{0,24}(?:数据|策略|demo)|\b(?:this|current|our)\s+(?:project|repository|repo|plugin|page|task|readme)\b/iu.test(
      compact,
    ) ||
    /\b(?:this|current|our)\s+(?:project|repository|repo|plugin|page|task|readme)\b/iu.test(
      evidence,
    );
  const taskSummary =
    /下一环节|下一阶段|先做|先不做|后做|不定时.{0,8}(?:补|更新)|增量拉取|上传.{0,8}demo|数据层.{0,8}更新|回测模块.{0,8}复用/iu.test(
      summary,
    );
  const scopedPrinciple =
    ["观点与想法", "稳定偏好"].includes(proposal.type) &&
    proposal.certainty !== "明确" &&
    Boolean(proposal.scope.trim()) &&
    !taskSummary &&
    /验证|复用|取舍|原则|偏好|倾向|优先|权衡|validation|reuse|trade.off/iu.test(proposal.content);
  if (taskInstruction && !personalStatement && !scopedPrinciple)
    throw new Error(
      "This is a project-specific task detail; retain personal meaning or a supported scoped principle instead",
    );
}
