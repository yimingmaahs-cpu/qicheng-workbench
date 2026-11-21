// Adapted workflow: the user's local resume-expert-main project (see README).
import { createHash } from 'node:crypto';
import { cleanResumeProse } from './resume-structure.mjs';
const draftHash = text => createHash('sha256').update(text).digest('hex');
const string = (value, limit = 1500) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const list = (value, limit = 12) => Array.isArray(value) ? value.slice(0, limit) : [];
const strings = value => list(value).map(x => string(x)).filter(Boolean);
export const STYLES = { concise: '简洁清晰', evidence: '突出行动与证据', restrained: '克制表达、降低夸张' };

export function localExpert(text, target) {
  const lines = text.split('\n').map(x => x.trim()).filter(Boolean);
  const requirements = (target?.description || '').split(/[\n；;]/).map(x => x.replace(/^\s*(?:[-•]\s*|\d+[.、)）](?!\d)\s*)/, '').trim()).filter(x => x.length > 5).slice(0, 12);
  const keywords = [...new Set((target?.keywords || '').split(/[,，、;；\n]/).map(x => x.trim()).filter(Boolean))].slice(0, 20);
  const examples = lines.filter(x => /负责|参与|协助|完成|设计|研究|运营|开发|销售|交付|responsible|built|developed/i.test(x) && x.length >= 18).slice(0, 3);
  return {
    engine: 'local', note: '本地模式按原文拆分 JD、查找关键词并提供补充模板；不做语义匹配评分。',
    jdAnalysis: { responsibilities: requirements.filter(x => !/学历|本科|硕士|博士|必须|至少|年以上|资格|证书/.test(x)), hardRequirements: requirements.filter(x => /学历|本科|硕士|博士|必须|至少|年以上|资格|证书/.test(x)), keywords },
    matchItems: keywords.map(keyword => {
      const evidence = lines.find(x => x.toLowerCase().includes(keyword.toLowerCase())) || '';
      return { jdRequirement: keyword, resumeEvidence: evidence, evidenceStrength: evidence ? 'weak' : 'none', optimizationSuggestion: evidence ? '仅确认出现该关键词；请补充使用场景和个人贡献，不能据此认定满足岗位要求。' : '未找到直接文字证据。有真实经历再补充，没有则如实保留缺口。' };
    }),
    followUpQuestions: [
      ...examples.map((line, i) => ({ id: `fu-${i + 1}`, question: `关于“${line.slice(0, 100)}”，你本人具体采取了什么行动？使用了什么方法？`, purpose: '区分个人贡献与团队工作' })),
      { id: 'fu-result', question: '选一段最相关经历，补充实际交付物、使用对象、结果和可核验依据。没有可靠数字时可以描述反馈。', purpose: '补足成果与证据' },
    ],
    optimizedItems: examples.map((line, i) => ({ id: `opt-${i + 1}`, before: line, after: `${line.replace(/[。；;]$/, '')}；通过[待补充：具体方法]，形成[待补充：实际交付物或结果]。`, reason: '保留原有事实，提示补充方法和成果。请先填完占位符，再采纳到草稿。', riskWarning: '本地表达模板，未生成新事实。', verified: true })),
    interviewPrep: [
      ...examples.map(line => ({ question: `请展开介绍：${line.slice(0, 100)}`, approach: '按背景、目标、个人行动、结果组织回答；说明方案取舍及个人负责的边界。', evidence: ['相关交付物或脱敏截图', '结果口径和个人贡献说明'] })),
      { question: '为什么选择这个方向？哪段经历最能支持你的选择？', approach: '结合你实际填写的岗位要求作答，引用一段真实经历，不把关键词覆盖等同于胜任。', evidence: ['目标岗位原始 JD', '一段能讲清过程与结果的经历'] },
    ],
  };
}

export const EXPERT_SCHEMA = `"expert": {
  "jdAnalysis": {"requirements":[{"id":"jd-1","text":"一项明确的岗位要求","evidence":"逐字摘取本次JD中的连续原文，不拼接或补写","kind":"responsibility|hard|skill|bonus","priority":"high|medium|low"}],"responsibilities":["JD职责"],"hardRequirements":["JD明确的硬性要求"],"keywords":["JD关键词"]},
  "matchItems":[{"requirementId":"jd-1","jdRequirement":"对应要求","jdEvidence":"该要求的JD原文","resumeEvidence":"逐字引用简历连续原文；没有则空串","evidenceStrength":"strong|medium|weak|none","optimizationSuggestion":"解释经历如何支持要求；缺证据时明确缺口，不把JD技能写成已有技能"}],
  "followUpQuestions":[{"requirementId":"jd-1","jdRequirement":"对应要求","jdEvidence":"该要求的JD原文","question":"针对该要求下真实经历缺少的信息提出追问","purpose":"回答能补足什么证据"}],
  "optimizedItems":[{"requirementId":"jd-1","jdRequirement":"对应要求","jdEvidence":"该要求的JD原文","before":"逐字引用待修改的连续原文","after":"重组已有事实，突出与这项要求相关的行动和产出，不移植JD中的技能、经历或数字，不返回与原文相同的改写","reason":"说明改写支持哪项要求及所用事实","riskWarning":"仍需核验的内容"}],
  "noRewriteReason":"没有可安全改写的内容时说明具体原因；不得为凑数制造经历",
  "interviewPrep":[{"question":"围绕真实经历的面试问题","approach":"回答思路，不编造答案","evidence":["应准备的证据"]}]
}`;

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const modelError = message => Object.assign(new Error(message), { status: 502 });
function requirementLink(item, requirements) {
  const requirement = requirements.find(r => r.id === string(item.requirementId, 100) && r.text && r.evidence);
  return requirement ? { requirementId: requirement.id, jdRequirement: requirement.text, jdEvidence: requirement.evidence } : { requirementId: '', jdRequirement: string(item.jdRequirement), jdEvidence: '' };
}

export function normalizeOptimizations(items, text, { requirements = [], requireTargeted = false, strict = false } = {}) {
  if (strict && !Array.isArray(items)) throw modelError('模型改写结果缺少 optimizedItems 数组，请重试。');
  return list(items, 8).filter(x => x && typeof x === 'object').map((item, i) => {
    const before = string(item.before, 4000), after = string(item.after, 5000);
    const link = requirementLink(item, requirements), targeted = !requireTargeted || Boolean(link.requirementId);
    const complete = !strict || !/\[(?:待补充|实际|真实|具体|可验证)[^\]]*\]/.test(after);
    const riskWarning = [string(item.riskWarning), !targeted ? '未关联可核验的 JD 要求，不能直接采纳为岗位定制改写。' : '', !complete ? '模型仅返回了待填模板，请补充回答后重新生成可用改写。' : ''].filter(Boolean).join('；');
    return { id: `opt-${i + 1}`, ...link, before, after, reason: string(item.reason), riskWarning, verified: Boolean(before && text.includes(before) && targeted && complete) };
  }).filter(x => x.before && x.after && (!strict || x.before !== x.after));
}

export function normalizeExpert(raw, text, target, { strict = false } = {}) {
  if (!object(raw)) {
    if (strict) throw modelError('模型未返回有效的 expert 分析，请重试。');
    return { ...localExpert(text, target), note: '本次模型未返回扩展分析；以下为本地辅助检查，可重新分析。' };
  }
  const jd = raw.jdAnalysis || {};
  if (strict && (!object(jd) || ['requirements', 'responsibilities', 'hardRequirements', 'keywords'].some(key => !Array.isArray(jd[key])) || ['matchItems', 'followUpQuestions', 'optimizedItems', 'interviewPrep'].some(key => !Array.isArray(raw[key])))) throw modelError('模型分析缺少必要数组，请重新生成完整诊断。');
  const description = typeof target?.description === 'string' ? target.description : '';
  const requirements = [], originalIds = new Map(), ambiguousIds = new Set();
  if (description) for (const item of list(jd.requirements, 24)) {
    if (!object(item)) continue;
    const requirement = string(item.text), evidence = string(item.evidence, 4000);
    if (!requirement || !evidence || !description.includes(evidence)) continue;
    const id = `jd-${requirements.length + 1}`, inputId = string(item.id, 100) || id;
    requirements.push({ id, text: requirement, evidence, kind: ['responsibility', 'hard', 'skill', 'bonus'].includes(item.kind) ? item.kind : 'skill', priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium' });
    if (originalIds.has(inputId) || ambiguousIds.has(inputId)) { originalIds.delete(inputId); ambiguousIds.add(inputId); }
    else originalIds.set(inputId, id);
  }
  if (strict && description && !requirements.length) throw modelError('模型未提取到能在本次 JD 中逐字核验的岗位要求，请重试。');
  const linked = item => ({ ...item, requirementId: originalIds.get(string(item.requirementId, 100)) || '' });
  const matchItems = description ? list(raw.matchItems, 24).filter(object).map(item => {
    const link = requirementLink(linked(item), requirements);
    if (strict && !link.requirementId) return null;
    const quote = string(item.resumeEvidence, 4000), verified = Boolean(quote && text.includes(quote));
    return { ...link, resumeEvidence: verified ? quote : '', evidenceStrength: verified && ['strong', 'medium', 'weak'].includes(item.evidenceStrength) ? item.evidenceStrength : 'none', optimizationSuggestion: string(item.optimizationSuggestion) };
  }).filter(item => item?.jdRequirement) : [];
  if (strict && description) {
    if (!matchItems.length) throw modelError('模型匹配结果没有关联有效的 JD 要求，请重新分析。');
    for (const requirement of requirements) if (!matchItems.some(item => item.requirementId === requirement.id)) matchItems.push({ ...requirementLink({ requirementId: requirement.id }, requirements), resumeEvidence: '', evidenceStrength: 'none', optimizationSuggestion: '本次诊断未提供这项要求的简历证据；请核对原文并补充真实经历，不能据此认定满足要求。' });
  }
  return {
    engine: 'ai', note: '模型给出语义分析，引用需能在原文中找到；证据强弱不代表录用概率。',
    jdAnalysis: description ? { requirements, responsibilities: strict ? requirements.filter(item => item.kind === 'responsibility').map(item => item.text) : strings(jd.responsibilities), hardRequirements: strict ? requirements.filter(item => item.kind === 'hard').map(item => item.text) : strings(jd.hardRequirements), keywords: strings(jd.keywords).filter(keyword => !strict || description.toLowerCase().includes(keyword.toLowerCase())) } : { requirements: [], responsibilities: [], hardRequirements: [], keywords: [] },
    matchItems,
    followUpQuestions: list(raw.followUpQuestions, 8).filter(x => x && typeof x.question === 'string' && x.question.trim()).map((q, i) => ({ id: `fu-${i + 1}`, ...requirementLink(linked(q), requirements), question: string(q.question), purpose: string(q.purpose) })),
    optimizedItems: normalizeOptimizations(list(raw.optimizedItems, 8).filter(object).map(linked), text, { requirements, requireTargeted: strict && Boolean(description), strict }),
    noRewriteReason: string(raw.noRewriteReason),
    interviewPrep: list(raw.interviewPrep, 8).filter(x => x && typeof x.question === 'string' && x.question.trim()).map(q => ({ question: string(q.question), approach: string(q.approach), evidence: strings(q.evidence) })),
  };
}

export function workspaceFor(report) {
  return report.workspace || { version: 0, answers: {}, edits: {}, draft: report.sourceText, applied: [], style: 'concise' };
}

export function applyOptimization(report, index, after) {
  const workspace = workspaceFor(report);
  const item = (workspace.optimizedItems || report.expert?.optimizedItems || [])[index];
  if (!item?.verified || !item.before) throw new Error('未找到可核对的原文，不能直接替换。');
  const generated = (report.engine === 'ai' || workspace.optimization?.engine === 'ai') && after.trim() === item.after;
  if (generated) after = cleanResumeProse(after);
  if (!after.trim() || /\[(?:待补充|实际|真实|具体|可验证)[^\]]*\]/.test(after)) throw new Error('请补齐或删除待补充占位符，再采纳修改。');
  if (after.trim() === item.before) throw new Error('建议与原文相同，无需采纳。');
  if ((workspace.applied || []).some(change => change.before === item.before && workspace.draft.includes(change.after))) throw new Error('这段原文的修改已采纳，请在定稿中继续编辑，避免重复追加。');
  const at = workspace.draft.indexOf(item.before);
  if (at < 0) throw new Error('草稿中已找不到这段原文，可能已采纳或手动修改，请在定稿中校对。');
  if (workspace.draft.indexOf(item.before, at + 1) >= 0) throw new Error('这段原文在草稿中出现多次，请在定稿中手动修改，避免替换错位置。');
  return { ...workspace, draft: workspace.draft.slice(0, at) + after.trim() + workspace.draft.slice(at + item.before.length), applied: [...(workspace.applied || []), { before: item.before, after: after.trim(), auditStatus: item.auditStatus === 'pass' ? (generated || after.trim() === item.after ? 'pass' : 'user_modified') : undefined, at: new Date().toISOString() }] };
}

export function targetedDraft(report) {
  const saved = workspaceFor(report);
  const eligible = (report.target?.description || report.expert?.structure?.version === 1) && ((report.engine === 'ai' && report.expert?.engine === 'ai' && report.reviewProcess?.version >= 2) || saved.optimization?.engine === 'ai');
  if (!eligible) throw new Error('请先提供 JD 并生成 AI 定向改写，再查看完整定向稿。');
  const items = saved.optimizedItems || report.expert.optimizedItems || [];
  const copy = { ...report, workspace: { ...saved, draft: report.sourceText, applied: [] } }, used = [], skipped = [];
  for (const [index, item] of items.entries()) {
    try {
      if (!item.verified || (report.reviewProcess?.version !== 3 && (!item.requirementId || !item.jdEvidence)) || (item.jdEvidence && !report.target?.description?.includes(item.jdEvidence))) throw new Error('原文或 JD 依据未通过核对。');
      if (report.reviewProcess?.version === 3 && (item.auditStatus !== 'pass' || (saved.edits?.[index] !== undefined && saved.edits[index] !== item.after))) throw new Error('建议已被手动修改或核查未通过，不自动合入；可在修改对照中本人确认采纳。');
      const start = report.sourceText.indexOf(item.before), end = start + item.before.length;
      if (!item.before || start < 0) throw new Error('报告原文中未找到对应内容。');
      if (report.sourceText.indexOf(item.before, start + 1) >= 0) throw new Error('原文引用出现多次，需手动核对替换位置。');
      if (used.some(range => start < range.end && end > range.start)) throw new Error('与已合入的修改范围重叠，请在修改对照中核对。');
      const proposed = saved.edits?.[index] ?? item.after;
      const after = proposed === item.after ? cleanResumeProse(proposed) : proposed;
      if (item.before === after) continue;
      applyOptimization(copy, index, after);
      used.push({ start, end, after: after.trim() });
    } catch (error) { skipped.push({ index, reason: error.message }); }
  }
  // Replace original offsets backwards so inserted text cannot become another item's source.
  let draft = report.sourceText;
  for (const range of used.sort((a, b) => b.start - a.start)) draft = draft.slice(0, range.start) + range.after + draft.slice(range.end);
  return { reportId: report.id, reportRevision: report.revision, workspaceVersion: saved.version, draft, appliedCount: used.length, totalCount: items.length, skipped };
}

// Only an untouched original or our unchanged generated draft can be refreshed.
// Manual content, answers and prior applied edits remain in their existing workspace/history.
export function initializeStructuredDraft(report, previous = workspaceFor(report)) {
  const workspace = workspaceFor(report), structure = report.expert?.structure;
  if (!structure?.experienceCount || structure.readyCount !== structure.experienceCount) return workspace;
  const untouched = previous.draft === report.sourceText && !previous.applied?.length && !Object.keys(previous.edits || {}).length;
  if (!untouched && (!previous.generatedDraftHash || draftHash(previous.draft) !== previous.generatedDraftHash || Object.keys(previous.edits || {}).length)) return workspace;
  const preview = targetedDraft(report);
  if (!preview.appliedCount || preview.skipped.length) return workspace;
  const items = workspace.optimizedItems || report.expert.optimizedItems;
  return { ...workspace, draft: preview.draft, generatedDraftHash: draftHash(preview.draft), applied: items.filter(item => item.before !== cleanResumeProse(item.after)).map(item => ({ before: item.before, after: cleanResumeProse(item.after), auditStatus: 'pass', at: new Date().toISOString() })) };
}

export function expertMarkdown(report) {
  const expert = report.expert;
  if (!expert) return '';
  const w = workspaceFor(report);
  const noRewriteReason = w.optimization?.noRewriteReason ?? expert.noRewriteReason;
  const basis = item => item.jdEvidence ? `JD 原文依据：${item.jdEvidence}\n\n` : '';
  const requirements = expert.jdAnalysis.requirements?.length ? expert.jdAnalysis.requirements.map(item => `- ${item.id}：${item.text}\n  JD 原文依据：${item.evidence}`).join('\n') : [...expert.jdAnalysis.responsibilities.map(x => `- 职责：${x}`), ...expert.jdAnalysis.hardRequirements.map(x => `- 要求：${x}`)].join('\n');
  const score = report.targetFit?.score;
  const scoring = score ? `\n## 简历与 JD 匹配度（材料证据）\n\n${score.score}/100 · 证据覆盖 ${score.coverage}% · ${score.unknowns.length} 项未说明 · ${score.conflicts.length} 项明确冲突\n\n${score.note}\n\n${score.includesAnswers ? '评分包含本次补充回答，不一定已写入草稿。' : '基于分析时的原文。'}${report.reviewProcess?.answersStale ? ' 回答已修改，当前分数待更新。' : ''}\n\n${score.formula}\n\n${score.dimensions.map(d => `- ${d.label}：${d.earned}/${d.weight}，${d.unknown} 项未说明`).join('\n')}\n\n${score.items.map(i => `- ${i.text}：${i.earned}/${i.weight}；${i.conflict ? '明确冲突' : i.unknown ? '材料未说明' : ({ direct: '直接证据', transferable: '可迁移证据', weak: '弱线索' })[i.support] || i.eligibility}。${i.reason}`).join('\n')}\n` : '';
  const flow = report.reviewProcess?.version === 3 ? `\n流程状态：${report.reviewProcess.status === 'completed' ? '完成' : '部分完成'}${report.reviewProcess.error ? '；' + report.reviewProcess.error : ''}\n` : '';
  const withheld = (expert.withheldItems || []).map(x => `- 原文：${x.before}\n  未采纳原因：${x.riskWarning}`).join('\n');
  return `${flow}${scoring}\n## 岗位拆解与证据匹配\n\n${expert.note}\n\n${requirements}\n\n${expert.matchItems.map(x => `### ${x.jdRequirement}\n\n${basis(x)}证据：${x.resumeEvidence || '未找到可核验的原文'}\n\n${x.optimizationSuggestion}`).join('\n\n')}\n\n## 经历追问\n\n${expert.followUpQuestions.map(q => `### ${q.question}\n\n${basis(q)}${w.answers[q.id] || '尚未回答'}`).join('\n\n')}\n\n## 修改对照\n\n${(w.optimizedItems || expert.optimizedItems).map((x, i) => `${basis(x)}原文：${x.before}\n\n建议：${w.edits?.[i] ?? x.after}\n\n理由：${x.reason}\n\n核查状态：${x.auditStatus === 'pass' ? w.edits?.[i] !== undefined && w.edits[i] !== x.after ? '用户修改，未重新核查' : '独立核查通过，仍需本人核对事实' : '旧版建议，请本人核对'}\n\n待核实：${x.riskWarning || '请本人核对事实'}`).join('\n\n---\n\n')}${noRewriteReason ? `\n\n未生成改写的原因：${noRewriteReason}` : ''}${withheld ? `\n\n## 未通过核查的修改\n\n${withheld}` : ''}\n\n## 面试准备\n\n${expert.interviewPrep.map(q => `### ${q.question}\n\n${q.approach}\n\n准备：${q.evidence.join('；')}`).join('\n\n')}\n`;
}
