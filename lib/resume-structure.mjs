// Keep source offsets and line IDs intact for evidence; rewrite whole experiences.
const clean = text => text.trim().replace(/^#{1,6}\s*/, '').replace(/^\*\*(.+)\*\*$/, '$1').replace(/[：:]$/, '').trim();
const experienceHeading = /^(?:(?:工作|实习|项目|校园|社团|科研|研究|学术|实践|竞赛)(?:经历|经验)|社会实践|Projects|WorkExperience|Experience)$/i;
const otherHeading = /^(?:个人信息|基本信息|联系方式|教育背景|教育经历|个人能力|专业技能|个人技能|技能清单|技能专长|技能与能力|技能特长|技能|资格证书|持有证书|荣誉奖项|奖项荣誉|获奖情况|获奖经历|荣誉(?:与|及)?技能|荣誉|论文(?:成果|与成果|发表)?|自我评价|个人简介|个人优势|兴趣爱好|求职意向|Education|Skills|Awards|Summary|Certifications|Publications)$/i;
const dates = /\d{4}(?:[./-]\d{1,2}|年\d{1,2}[月日])?\s*(?:[-—–~～至]|到)\s*(?:\d{4}(?:[./-]\d{1,2}|年\d{1,2}[月日])?|至今|现在|present)/i;
export const EXPERIENCE_LABELS = ['项目背景', '项目职责', '项目成果'];
// Remove editorial annotations, not legitimate dates, abbreviations or metrics.
// Only standalone note clauses are removed; substantive prose is not guessed at.
const editorialClause = /^(?:目标口径|(?:数据)?(?:尚未|未经|未|待)(?:外部)?(?:验证|核实|核验|确认)|(?:仅为|仅供)?(?:本人|用户|简历)自述(?:目标|数据)?|未提供(?:达成数据|验证材料)|需(?:本人)?(?:核实|确认)|仅供参考|请(?:自行|本人)?核实)$/;
export function cleanResumeProse(text) {
  const withoutNotes = text.replace(/[（(]([^（）()\n]*)[）)]/g, (whole, content) => {
    if (/^(?:备注|注)[：:]|^建议(?:补充|核实|确认)/.test(content.trim())) return '';
    const parts = content.split(/[，,；;。]/), kept = parts.filter(part => !editorialClause.test(part.trim()));
    if (kept.length === parts.length) return whole;
    const remaining = kept.map(part => part.trim()).filter(Boolean).join('，');
    return remaining ? whole[0] + remaining + whole.at(-1) : '';
  });
  return withoutNotes.split('\n').map(line => line.replace(/(^|[：:，,；;。])([^：:，,；;。]+)(?=[，,；;。]|$)/g,
    (whole, prefix, clause) => editorialClause.test(clause.trim()) ? prefix : whole
  ).replace(/([，,；;。])\s*([，,；;。])/g, '$2')).join('\n');
}
export function experienceBlocks(text, lines) {
  const result = [];
  let active = false, group = [];
  const header = b => {
    const t = clean(b.text);
    return !/^(?:[-*]\s|[•□]|\d{1,2}[.、)）]|项目(?:背景|职责|成果|描述)[:：])/.test(t) &&
      ((t.length < 200 && dates.test(t) && !/[。；;]/.test(t)) || /^\*\*[^*]+\*\*$/.test(b.text.trim()) || /^#{3,6}[^#]/.test(b.text.trim()) || /^项目(?:名称|名)[:：]/.test(t) ||
        (t.length < 120 && /[|｜].*(?:项目|课题|系统|平台|研究)$/.test(t) && !/[。；;]|负责|参与|输出|完成/.test(t)));
  };
  const flush = () => {
    if (!group.length) return;
    const first = group[0], last = group.at(-1);
    const bodyAt = group.findIndex(b => !header(b));
    const heading = group.slice(0, bodyAt < 0 ? group.length : bodyAt).map(b => b.text.trim()).join('\n');
    result.push({ id: first.id, start: first.start, text: text.slice(first.start, last.start + last.text.length), experience: true, header: heading, sourceIds: group.map(b => b.id) });
    group = [];
  };
  for (const b of lines) {
    const title = clean(b.text).replace(/[ \t]/g, '');
    if (/^(?:姓名|电话|手机(?:号码)?|(?:电子)?邮箱|联系(?:方式|电话))[:：]/.test(title)) {
      flush(); result.push(b); continue;
    }
    if (experienceHeading.test(title) || otherHeading.test(title) || (/^#{1,2}[^#]/.test(b.text.trim()) && b.text.trim().length < 50)) {
      flush(); active = experienceHeading.test(title); result.push(b); continue;
    }
    if (!active) { result.push(b); continue; }
    // Keep adjacent title/date lines together in either order, but never attach
    // a new dated position to the previous position merely because it has no body.
    const dateOnly = clean(b.text).match(dates)?.[0] === clean(b.text);
    const continuesHeader = group.length && group.every(header) &&
      ((dateOnly && !group.some(line => dates.test(line.text))) || (!dates.test(b.text) && group.some(line => dates.test(line.text))));
    if (header(b) && group.length && !continuesHeader) flush();
    group.push(b);
  }
  flush();
  return result;
}
export function experienceParts(after) {
  const matches = [...after.matchAll(/^(项目背景|项目职责|项目成果)[：:][ \t]*(.*)$/gm)];
  if (matches.length !== 3 || matches.some((m, i) => m[1] !== EXPERIENCE_LABELS[i])) return null;
  return matches.map((m, i) => after.slice(m.index + m[0].length - m[2].length, matches[i + 1]?.index ?? after.length).trim());
}
