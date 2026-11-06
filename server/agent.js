// CourseHub 学习助手 Agent
// 架构：意图识别 -> 实体抽取 -> 检索（平台数据 data.json） -> 综合回答
// 内置引擎完全离线工作，只引用 data.json 中真实存在的课程 / 教师 / 资料 / 问答 /
// 评价 / 学习小组，绝不编造事实。可选的 LLM 适配器（环境变量配置时）只做语言润色，
// 仍以检索到的证据为唯一事实来源，失败时自动回退到内置引擎。
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DATA = path.join(__dirname, 'data.json');
const SESSIONS_FILE = path.join(__dirname, 'agent-sessions.json');

// ---------------------------------------------------------------------------
// 数据与会话持久化
// ---------------------------------------------------------------------------
function loadData() { return JSON.parse(fs.readFileSync(DATA, 'utf8')); }

let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch (e) { sessions = {}; }

function persistSessions() {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2)); } catch (e) { /* 会话持久化失败不影响回答 */ }
}

function getSession(id) {
  if (!sessions[id]) sessions[id] = { sessionId: id, lastCourseId: null, lastCourseName: null, history: [], createdAt: new Date().toISOString() };
  return sessions[id];
}

// ---------------------------------------------------------------------------
// 中文分词（词 + 二字 gram）与打分
// ---------------------------------------------------------------------------
// 通用虚词二字 gram：检索时忽略，避免“没有/怎么”这类词带入无关结果
const STOP_BIGRAMS = new Set(['没有', '怎么', '什么', '是否', '请问', '可以', '这个', '那个', '一下', '就是', '还是', '或者', '如果', '因为', '所以', '然后', '但是', '可能', '应该', '需要', '想要', '有没', '在哪', '哪里', '多少', '哪些', '哪门']);

function tokenize(q) {
  const terms = new Set();
  const text = String(q || '').toLowerCase();
  for (const m of text.match(/[a-z0-9]+/g) || []) terms.add(m);
  for (const m of text.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (m.length >= 2) terms.add(m);
    for (let i = 0; i + 1 < m.length; i++) {
      const bg = m.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(bg)) terms.add(bg);
    }
  }
  return [...terms];
}

// terms 在 haystack 中命中时按词长加权；quality 为 0-1 的质量加权（评分 / 下载量 / 点赞）
function scoreText(terms, haystack, quality) {
  const hay = String(haystack || '').toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (t.length < 2) continue;
    if (hay.includes(t)) s += t.length;
  }
  return s * (1 + 0.5 * (quality || 0));
}

function topN(scored, n) {
  return scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, n);
}

// ---------------------------------------------------------------------------
// 实体抽取：课程（代码 / 全名）、教师、学分、备考天数
// ---------------------------------------------------------------------------
function findCourse(d, msg) {
  const code = String(msg || '').toUpperCase().match(/\b[A-Z]{2}\d{3}\b/);
  if (code) {
    const c = d.courses.find(x => x.code.toUpperCase() === code[0]);
    if (c) return c;
  }
  // 全名直接命中
  for (const c of d.courses) if (msg.includes(c.name)) return c;
  // 部分课名：课程名前缀（≥3 字，如“数据结构”）或课名内任意连续子串（≥4 字）出现在提问中
  let best = null, bestScore = 0;
  for (const c of d.courses) {
    let p = 0;
    while (p < c.name.length && msg.includes(c.name.slice(0, p + 1))) p++;
    if (p >= 3 && p > bestScore) { best = c; bestScore = p; }
    for (let len = Math.min(c.name.length, 6); len >= 4; len--) {
      for (let i = 0; i + len <= c.name.length; i++) {
        if (msg.includes(c.name.slice(i, i + len)) && len > bestScore) { best = c; bestScore = len; }
      }
    }
  }
  return best;
}

function findTeacher(d, msg) {
  let best = null;
  for (const t of d.teachers) {
    if (msg.includes(t.name) && (!best || t.name.length > best.name.length)) best = t;
  }
  return best;
}

function extractCredits(msg) {
  const m = String(msg || '').match(/(\d+)\s*学分/);
  return m ? Number(m[1]) : null;
}

function extractDays(msg) {
  const m = String(msg || '').match(/(\d+)\s*天/);
  return m ? Math.max(1, Math.min(30, Number(m[1]))) : null;
}

// ---------------------------------------------------------------------------
// 意图识别（关键词打分，按优先级处理重叠意图）
// ---------------------------------------------------------------------------
const INTENT_RULES = [
  ['学习计划', ['复习计划', '学习计划', '冲刺', '天复习', '怎么学', '学习路线', '备考', '打卡', '安排一下', '怎么复习']],
  ['考试复习', ['期末', '期中', '考试', '会考', '考什么', '重点', '真题', '题库', '复习']],
  ['资料查找', ['资料', '讲义', '课件', '笔记', '习题', '模板', '下载', '范文']],
  ['老师评价', ['老师', '教授', '讲师', '教师', '谁教', '上课', '讲课', '老师怎么样']],
  ['选课咨询', ['选课', '推荐', '选什么', '哪门', '学分', '水课', '难吗', '好不好', '适合', '避坑', '选修', '必修']],
  ['闲聊兜底', ['你好', '您好', 'hi', 'hello', '你是谁', '谢谢', '再见', '在吗', '在么']],
];
const INTENT_LABEL = {
  '选课咨询': '选课咨询', '资料查找': '资料查找', '考试复习': '考试复习',
  '老师评价': '老师评价', '学习计划': '学习计划', '闲聊兜底': '闲聊兜底',
};

function classifyIntent(msg) {
  // “有没有……资料 / 下载……”且没有明确考试词 → 资料查找（优先于“真题”的考试复习归类）
  if (/资料|下载|讲义|课件|笔记|模板|范文/.test(msg) && !/期末|期中|考试|会考|考什么|重点/.test(msg)) return '资料查找';
  // 提到“课”并问怎么样 / 难不难（且不是在问老师）→ 选课咨询
  if (/课/.test(msg) && !/老师|教授|讲师|教师/.test(msg) && /怎么样|如何|难吗|好不好|值得吗|水吗/.test(msg)) return '选课咨询';
  let best = { intent: '闲聊兜底', score: 0 };
  for (const [intent, keywords] of INTENT_RULES) {
    let s = 0;
    for (const k of keywords) if (msg.includes(k)) s += k.length;
    if (s > best.score) best = { intent, score: s };
  }
  return best.intent;
}

// ---------------------------------------------------------------------------
// 检索工具：全部在 data.json 上打分，质量加权（评分 / 下载量 / 点赞 / 已采纳）
// ---------------------------------------------------------------------------
function retrieve(d, terms) {
  const courses = topN(d.courses.map(c => ({
    type: 'course', id: c.id, title: c.code + ' ' + c.name,
    detail: c.teacher + ' · ' + c.department + ' · ' + c.credits + '学分 · 评分' + c.rating,
    score: scoreText(terms, c.code + ' ' + c.name + ' ' + c.teacher + ' ' + c.department, c.rating / 5),
    item: c,
  })), 5);
  const materials = topN(d.materials.map(m => ({
    type: 'material', id: m.id, title: m.title,
    detail: m.course + ' · ' + m.type + ' · ' + m.uploader + ' · 下载' + m.downloads + '次',
    score: scoreText(terms, m.title + ' ' + m.course + ' ' + m.type, Math.min(1, m.downloads / 200)),
    item: m,
  })), 5);
  const questions = topN(d.questions.map(q => {
    const acc = d.answers.find(a => a.questionId === q.id && a.accepted);
    return {
      type: 'question', id: q.id, title: q.title,
      detail: q.course + ' · ' + q.status + (acc ? ' · 已采纳回答：' + acc.content : ' · 暂无采纳回答'),
      score: scoreText(terms, q.title + ' ' + q.content + ' ' + q.course, acc ? 1 : 0.3),
      item: q, accepted: acc || null,
    };
  }), 5);
  const teachers = topN(d.teachers.map(t => ({
    type: 'teacher', id: t.id, title: t.name + '（' + t.title + '）',
    detail: t.department + ' · 评分' + t.rating + ' · 主讲：' + (t.courses || []).join('、'),
    score: scoreText(terms, t.name + ' ' + t.department + ' ' + (t.courses || []).join(' '), t.rating / 5),
    item: t,
  })), 3);
  const reviews = topN(d.reviews.filter(r => r.status === 'approved').map(r => {
    const c = d.courses.find(x => x.id === r.courseId);
    return {
      type: 'review', id: r.id, title: (c ? c.code + ' ' + c.name : '课程#' + r.courseId) + ' · ' + r.author,
      detail: '评分' + r.rating + '/5 · 难度' + r.difficulty + ' · 负担' + r.workload + ' · ' + r.comment,
      score: scoreText(terms, r.comment + ' ' + (c ? c.name : ''), Math.min(1, r.likes / 20)),
      item: r, course: c || null,
    };
  }), 5);
  const groups = topN(d.studyGroups.map(g => ({
    type: 'studyGroup', id: g.id, title: g.name,
    detail: g.course + ' · ' + g.time + ' · ' + g.place + ' · ' + g.members.length + '/' + g.capacity + '人',
    score: scoreText(terms, g.name + ' ' + g.course + ' ' + g.place, 0.3),
    item: g,
  })), 3);
  return { courses, materials, questions, teachers, reviews, groups };
}

function courseStats(d, courseId) {
  const rs = d.reviews.filter(r => r.courseId === courseId && r.status === 'approved');
  if (!rs.length) return null;
  const avg = f => Math.round(rs.reduce((s, r) => s + r[f], 0) / rs.length * 10) / 10;
  return { count: rs.length, rating: avg('rating'), difficulty: avg('difficulty'), workload: avg('workload') };
}

// ---------------------------------------------------------------------------
// 综合回答：每个意图一段模板，只用检索到的证据写答案
// ---------------------------------------------------------------------------
function synthesize(d, intent, ctx, ev) {
  const { course, teacher, credits, days } = ctx;
  const lines = [];
  const sources = [];

  if (intent === '选课咨询') {
    if (course) {
      const st = courseStats(d, course.id);
      lines.push('**' + course.code + ' ' + course.name + '**（' + course.teacher + '，' + course.department + '，' + course.credits + '学分，' + course.semester + '，平台评分 ' + course.rating + '，' + course.reviewCount + ' 条评价）');
      if (st) lines.push('根据 ' + st.count + ' 条已通过审核的评价：难度 ' + st.difficulty + '/5，负担 ' + st.workload + '/5，平均分 ' + st.rating + '/5。');
      // 优先用检索到的相关评价；检索无命中时（如追问“那门课难吗”）直接取该课点赞最高的已审核评价
      let quotes = ev.reviews.filter(r => r.course && r.course.id === course.id).slice(0, 2);
      if (!quotes.length) {
        quotes = d.reviews.filter(r => r.courseId === course.id && r.status === 'approved').sort((a, b) => b.likes - a.likes).slice(0, 2).map(r => ({ item: r }));
      }
      for (const q of quotes) {
        const r = q.item;
        lines.push('同学评价：「' + r.comment + '」（' + r.author + '，评分 ' + r.rating + '）');
        sources.push({ type: 'review', id: r.id, title: course.code + ' ' + course.name + ' · ' + r.author, detail: r.comment, score: r.likes });
      }
      sources.push(...ev.courses.filter(c => c.id === course.id));
      if (!quotes.length) lines.push('这门课目前还没有已通过审核的评价文字，可以先看看它的资料和问答。');
    } else {
      let pool = [...d.courses].sort((a, b) => b.rating - a.rating);
      const wantsRec = /推荐|选什么|哪门|适合|学分/.test(ctx.msg || '');
      if (credits !== null) pool = pool.filter(c => c.credits === credits);
      const picks = pool.slice(0, 3);
      // 明确问某门课但平台里没有：直说找不到，再给最接近的热门课，而不是假装推荐
      if (!wantsRec && credits === null && /课|课程/.test(ctx.msg || '')) {
        lines.push('平台里没有找到与你说的匹配的课程，12 门课里没有这门课。');
        lines.push('最接近的热门课程（按评分从高到低），你可以看看有没有想问的那门：');
        for (const c of pool.slice(0, 3)) {
          lines.push('- **' + c.code + ' ' + c.name + '**：' + c.teacher + ' · ' + c.department + ' · ' + c.credits + '学分 · 评分 ' + c.rating);
          sources.push({ type: 'course', id: c.id, title: c.code + ' ' + c.name, detail: c.teacher + ' · ' + c.credits + '学分 · 评分' + c.rating, score: c.rating });
        }
      } else if (!pool.length) {
        lines.push('平台里没有找到' + (credits !== null ? credits + '学分' : '') + '的课程。现有学分分布：' + [...new Set(d.courses.map(c => c.credits))].sort((a, b) => a - b).join('、') + ' 学分，你可以换个学分再问我。');
      } else {
        lines.push('按平台评分从高到低，给你推荐 ' + picks.length + ' 门' + (credits !== null ? credits + '学分' : '') + '课：');
        for (const c of picks) {
          const st = courseStats(d, c.id);
          lines.push('- **' + c.code + ' ' + c.name + '**：' + c.teacher + ' · ' + c.department + ' · ' + c.credits + '学分 · 评分 ' + c.rating + (st ? ' · 难度 ' + st.difficulty + '/5 · 负担 ' + st.workload + '/5' : ''));
          sources.push({ type: 'course', id: c.id, title: c.code + ' ' + c.name, detail: c.teacher + ' · ' + c.credits + '学分 · 评分' + c.rating, score: c.rating });
        }
      }
    }
  } else if (intent === '资料查找') {
    const hits = ev.materials.filter(m => m.score >= 4);
    if (course) {
      // 已确定一门课（点名或会话记忆追问）：直接列这门课的全部资料，按下载量排序
      const own = d.materials.filter(m => m.courseId === course.id).sort((a, b) => b.downloads - a.downloads);
      if (own.length) {
        lines.push('**' + course.code + ' ' + course.name + '** 共有 ' + own.length + ' 份资料（按下载量排序）：');
        for (const m of own) {
          lines.push('- **' + m.title + '**（' + m.type + ' · ' + m.uploader + '上传 · 下载 ' + m.downloads + ' 次）');
          sources.push({ type: 'material', id: m.id, title: m.title, detail: m.course + ' · ' + m.type, score: m.downloads });
        }
      } else {
        lines.push('**' + course.code + ' ' + course.name + '** 暂时还没有上传资料。');
      }
    } else if (!hits.length) {
      lines.push('没找到和你说的匹配的资料。平台现有资料按下载量前三是：');
      const top = [...d.materials].sort((a, b) => b.downloads - a.downloads).slice(0, 3);
      for (const m of top) {
        lines.push('- **' + m.title + '**（' + m.course + ' · ' + m.type + ' · 下载 ' + m.downloads + ' 次）');
        sources.push({ type: 'material', id: m.id, title: m.title, detail: m.course + ' · ' + m.type, score: m.downloads });
      }
    } else {
      lines.push('找到 ' + hits.length + ' 份相关资料（按相关度排序）：');
      for (const m of hits) {
        lines.push('- **' + m.title + '**（' + m.item.course + ' · ' + m.item.type + ' · ' + m.item.uploader + '上传 · 下载 ' + m.item.downloads + ' 次）');
        sources.push(m);
      }
    }
  } else if (intent === '考试复习') {
    const answered = ev.questions.filter(q => q.accepted && q.score >= 5).slice(0, 3);
    if (answered.length) {
      lines.push('问答区里有 ' + answered.length + ' 条相关提问已有采纳回答：');
      for (const q of answered) {
        lines.push('- **' + q.title + '**（' + q.item.course + '）\n  采纳回答（' + q.accepted.author + '）：' + q.accepted.content);
        sources.push(q);
      }
    }
    const examMats = ev.materials.filter(m => (m.item.type === '真题' || m.item.type === '习题') && m.score >= 4).slice(0, 3);
    if (examMats.length) {
      lines.push('相关真题 / 习题资料：');
      for (const m of examMats) {
        lines.push('- **' + m.title + '**（' + m.item.course + ' · 下载 ' + m.item.downloads + ' 次）');
        sources.push(m);
      }
    }
    const examTips = ev.reviews.filter(r => r.score >= 4 && /期末|期中|考试|开卷|背/.test(r.item.comment)).slice(0, 2);
    for (const r of examTips) {
      lines.push('考试相关评价（' + r.title + '）：「' + r.item.comment + '」');
      sources.push(r);
    }
    if (!answered.length && !examMats.length && !examTips.length) {
      lines.push('问答区和资料库里暂时没有和这门课考试直接相关的内容。建议你先告诉我具体是哪门课、考哪部分，我再帮你找对应的资料和已采纳回答；也可以直接去问答区提一个新问题。');
    }
  } else if (intent === '老师评价') {
    const t = teacher || (course ? d.teachers.find(x => x.name === course.teacher) : null) || ev.teachers[0]?.item || null;
    if (!t) {
      lines.push('没找到这位老师。平台共有 ' + d.teachers.length + ' 位教师，评分最高的是：');
      const top = [...d.teachers].sort((a, b) => b.rating - a.rating).slice(0, 3);
      for (const x of top) {
        lines.push('- **' + x.name + '**（' + x.title + ' · ' + x.department + ' · 评分 ' + x.rating + ' · 主讲 ' + (x.courses || []).join('、') + '）');
        sources.push({ type: 'teacher', id: x.id, title: x.name, detail: x.department + ' · 评分' + x.rating, score: x.rating });
      }
    } else {
      lines.push('**' + t.name + '**（' + t.title + ' · ' + t.department + ' · 平台评分 ' + t.rating + '/5）');
      lines.push('主讲课程：' + (t.courses || []).join('、') + '。');
      const tCourses = d.courses.filter(c => c.teacher === t.name);
      const tReviews = d.reviews.filter(r => r.status === 'approved' && tCourses.some(c => c.id === r.courseId)).sort((a, b) => b.likes - a.likes).slice(0, 2);
      for (const r of tReviews) {
        const c = tCourses.find(x => x.id === r.courseId);
        lines.push('学生评价（' + (c ? c.name : '') + '，' + r.author + '，评分 ' + r.rating + '/5）：「' + r.comment + '」');
        sources.push({ type: 'review', id: r.id, title: (c ? c.name : '') + ' · ' + r.author, detail: r.comment, score: r.likes });
      }
      if (!tReviews.length) lines.push('这门课目前还没有已通过审核的学生评价文字。');
      sources.push({ type: 'teacher', id: t.id, title: t.name, detail: t.department + ' · 评分' + t.rating, score: t.rating });
    }
  } else if (intent === '学习计划') {
    if (!course) {
      lines.push('做复习计划要先定一门课。请告诉我课程名或课程代码（比如“数据结构”），再告诉我离考试还有几天，我就按这门课的资料、真题和问答给你排一份逐日计划。');
      if (ctx.lastCourseName) lines.push('你刚才在聊的是「' + ctx.lastCourseName + '」，直接说“就这门课，7 天”也可以。');
    } else {
      const plan = buildPlan(d, course.id, days || 7);
      lines.push('已按 **' + course.code + ' ' + course.name + '** 给你排了一份 ' + plan.days + ' 天复习计划（以这门课的资料和已采纳问答为依据）：');
      for (const day of plan.plan) {
        lines.push('**第 ' + day.day + ' 天 · ' + day.title + '**：' + day.tasks.join('；'));
      }
      if (plan.groups.length) lines.push('还可以加入学习小组：' + plan.groups.map(g => g.name + '（' + g.time + '，' + g.place + '）').join('；'));
      sources.push(...plan.sources);
      ctx.plan = plan;
    }
  } else {
    lines.push('你好，我是 CourseHub 学习助手，专门用平台里的课程、资料、问答和评价来回答学习问题。');
    lines.push('你可以这样问我：');
    lines.push('- “数据结构难吗？”（选课咨询：看评分、难度和同学评价）');
    lines.push('- “推荐一门 3 学分的课”（按学分和评分推荐）');
    lines.push('- “数据结构期末会考红黑树吗？”（查已采纳回答和真题）');
    lines.push('- “李晓梅老师怎么样？”（教师评价）');
    lines.push('- “帮我做一份 7 天复习计划”（要先告诉我哪门课）');
    lines.push('我的回答只来自平台数据，没有找到的内容我会直接说不知道，不会编。');
  }

  return { reply: lines.join('\n'), sources };
}

// ---------------------------------------------------------------------------
// 学习计划生成器：按课程的真实资料 / 问答 / 小组排逐日计划
// ---------------------------------------------------------------------------
function buildPlan(d, courseId, days) {
  const course = d.courses.find(c => c.id === Number(courseId));
  if (!course) return null;
  const n = Math.max(1, Math.min(30, Number(days) || 7));
  const mats = d.materials.filter(m => m.courseId === course.id);
  const byType = t => mats.filter(m => m.type === t).sort((a, b) => b.downloads - a.downloads);
  const slides = byType('课件'), notes = byType('笔记'), exams = byType('真题'), drills = byType('习题'), others = byType('其他');
  const qa = d.questions.filter(q => q.courseId === course.id).map(q => ({
    q, accepted: d.answers.find(a => a.questionId === q.id && a.accepted) || null,
  }));
  const groups = d.studyGroups.filter(g => g.courseId === course.id);
  const st = courseStats(d, course.id);

  const plan = [];
  const pick = (arr, i) => arr.length ? arr[i % arr.length] : null;
  for (let day = 1; day <= n; day++) {
    const tasks = [];
    const srcs = [];
    if (day === 1) {
      const m = pick([...slides, ...notes], 0);
      tasks.push('通读' + (m ? '「' + m.title + '」' : '课程课件 / 笔记') + '，梳理整门课的知识框架');
      if (m) srcs.push(m);
      if (st) tasks.push('先看同学评价：难度 ' + st.difficulty + '/5、负担 ' + st.workload + '/5，按难度分配每天的量');
      tasks.push('加入学习小组的话可以先约一次自习时间');
    } else if (day === n) {
      const m = pick(exams, 0) || pick(drills, 0);
      tasks.push('用' + (m ? '「' + m.title + '」' : '真题 / 习题') + '做一次限时模拟，查漏补缺');
      if (m) srcs.push(m);
      const open = qa.filter(x => !x.accepted);
      if (open.length) tasks.push('把还没采纳回答的问题（' + open.map(x => '「' + x.q.title + '」').join('、') + '）再过一遍，去问答区追问或找同学讨论');
      tasks.push('复盘前几天的错题，重点只看采纳回答里提到的考点');
    } else {
      const mid = (day - 1) / Math.max(1, n - 1); // 0..1 的进度
      const answered = qa.filter(x => x.accepted);
      const qaRef = answered.length ? answered[(day - 2) % answered.length] : null;
      if (mid < 0.5) {
        // 精读阶段：三天一轮换——写提纲 / 默写自测 / 易错点对照，避免每天重复同一句话
        const m = pick([...notes, ...slides], day - 1);
        const mode = (day - 2) % 3;
        if (mode === 0) tasks.push('精读' + (m ? '「' + m.title + '」' : '课件 / 笔记') + '，把知识点写成自己的提纲');
        else if (mode === 1) tasks.push('按提纲默写一遍，卡住的地方回到' + (m ? '「' + m.title + '」' : '课件 / 笔记') + '里找答案');
        else if (qaRef) tasks.push('易错点对照：「' + qaRef.q.title + '」——' + qaRef.accepted.content);
        else tasks.push('精读' + (m ? '「' + m.title + '」' : '课件 / 笔记') + '，标出还没吃透的章节');
        if (m) srcs.push(m);
        if (mode !== 2 && qaRef) tasks.push('对照已采纳回答复习：「' + qaRef.q.title + '」——' + qaRef.accepted.content);
      } else {
        // 刷题阶段：三天一轮换——限时刷题 / 错题重做 / 小测
        const m = pick([...drills, ...exams], day - 1);
        const mode = (day - 2) % 3;
        if (mode === 0) tasks.push('限时刷题：' + (m ? '「' + m.title + '」' : '习题 / 真题') + '，做完对答案并记下错题');
        else if (mode === 1) tasks.push('错题重做：把前一天的错题再做一遍，只看采纳回答里提到的考点');
        else tasks.push('小测：用' + (m ? '「' + m.title + '」' : '习题 / 真题') + '做一次计时小测，错题记下来明天复盘');
        if (m) srcs.push(m);
        if (mode !== 1 && qaRef) tasks.push('易错点复查：「' + qaRef.q.title + '」——' + qaRef.accepted.content);
      }
    }
    if (groups.length && day % 2 === 0) tasks.push('小组自习：「' + groups[0].name + '」（' + groups[0].time + '，' + groups[0].place + '）');
    plan.push({ day, title: day === 1 ? '搭框架' : day === n ? '模拟冲刺' : '精读 + 刷题', tasks, materials: srcs.map(m => ({ id: m.id, title: m.title, type: m.type })) });
  }

  const sources = [];
  for (const m of mats) sources.push({ type: 'material', id: m.id, title: m.title, detail: m.course + ' · ' + m.type + ' · 下载' + m.downloads + '次', score: m.downloads });
  for (const g of groups) sources.push({ type: 'studyGroup', id: g.id, title: g.name, detail: g.course + ' · ' + g.time + ' · ' + g.place, score: 1 });
  return { course: { id: course.id, code: course.code, name: course.name, teacher: course.teacher, credits: course.credits }, days: n, plan, groups: groups.map(g => ({ id: g.id, name: g.name, time: g.time, place: g.place })), sources };
}

// ---------------------------------------------------------------------------
// 可选 LLM 适配器：OpenAI 兼容接口，仅在配置了环境变量时启用，失败即回退
// ---------------------------------------------------------------------------
function postJson(urlStr, body, apiKey, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      timeout: timeoutMs,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('bad json from llm')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('llm timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function llmEnhance(evidenceText, message) {
  const key = process.env.LLM_API_KEY, base = process.env.LLM_BASE_URL, model = process.env.LLM_MODEL;
  if (!key || !base || !model) return null;
  const system = '你是一名校园学习助手。只能依据下面提供的平台证据回答问题，证据里没有的内容就明确说不知道，绝不编造课程、教师、资料、数字或事实。回答用中文，简洁直接，提到具体内容时注明它来自哪条证据。';
  try {
    const res = await postJson(
      String(base).replace(/\/$/, '') + '/chat/completions',
      JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: '平台证据：\n' + evidenceText + '\n\n学生问题：' + message }], temperature: 0.2, max_tokens: 800 }),
      key, 15000,
    );
    const text = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
    return text ? String(text).trim() : null;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// 主入口：意图 -> 实体 -> 检索 -> 综合（可选 LLM 润色）-> 记忆
// ---------------------------------------------------------------------------
async function chat(sessionId, message) {
  const d = loadData();
  const msg = String(message || '').trim();
  const session = getSession(sessionId || 'default');
  const steps = [];

  if (!msg) return { reply: '请先输入你的问题，比如“数据结构难吗？”或者“推荐一门 3 学分的课”。', intent: '闲聊兜底', sources: [], steps: ['输入为空，直接返回提示'] };

  // 1. 意图识别
  const intent = classifyIntent(msg);
  steps.push('意图识别：' + intent);

  // 2. 实体抽取（含会话记忆补全：没有新实体时沿用上文课程）
  let course = findCourse(d, msg);
  const teacher = findTeacher(d, msg);
  const credits = extractCredits(msg);
  const days = extractDays(msg);
  let usedMemory = false;
  if (!course && session.lastCourseId && /那门|这门|它|这课|这门课|那课/.test(msg)) {
    course = d.courses.find(c => c.id === session.lastCourseId) || null;
    usedMemory = Boolean(course);
  }
  if (course) steps.push('实体抽取：课程 ' + course.code + ' ' + course.name + (teacher ? '；教师 ' + teacher.name : '') + (usedMemory ? '（来自会话记忆）' : ''));
  else if (teacher) steps.push('实体抽取：教师 ' + teacher.name);
  else steps.push('实体抽取：未提到具体课程或教师');

  // 3. 检索
  const terms = tokenize(msg);
  const ev = retrieve(d, terms);
  const evCount = ev.courses.length + ev.materials.length + ev.questions.length + ev.teachers.length + ev.reviews.length + ev.groups.length;
  steps.push('检索：课程 ' + ev.courses.length + ' 条 / 资料 ' + ev.materials.length + ' 条 / 问答 ' + ev.questions.length + ' 条 / 教师 ' + ev.teachers.length + ' 条 / 评价 ' + ev.reviews.length + ' 条 / 学习小组 ' + ev.groups.length + ' 条');

  // 4. 综合回答（内置引擎）
  const ctx = { course, teacher, credits, days, msg, lastCourseName: session.lastCourseName, plan: null };
  let { reply, sources } = synthesize(d, intent, ctx, ev);
  steps.push('综合：内置引擎基于 ' + sources.length + ' 条证据生成回答');

  // 5. 可选 LLM 润色（有配置且成功时才替换正文，证据与来源保持不变）
  if (process.env.LLM_API_KEY && process.env.LLM_BASE_URL && process.env.LLM_MODEL) {
    const evidenceText = sources.map((s, i) => '[' + (i + 1) + '] (' + s.type + ') ' + s.title + ' —— ' + s.detail).join('\n') || '（无匹配证据）';
    const polished = await llmEnhance(evidenceText, msg);
    if (polished) {
      reply = polished;
      steps.push('LLM 增强：已用配置的大模型润色回答（证据不变）');
    } else {
      steps.push('LLM 增强：调用失败，已回退到内置引擎回答');
    }
  }

  // 6. 记忆：记住本次课程 + 对话历史（写入 agent-sessions.json，data.json 不动）
  if (course) { session.lastCourseId = course.id; session.lastCourseName = course.name; }
  session.history.push({ role: 'user', content: msg, intent, at: new Date().toISOString() });
  session.history.push({ role: 'assistant', content: reply, intent, at: new Date().toISOString() });
  if (session.history.length > 40) session.history = session.history.slice(-40);
  persistSessions();

  const out = { reply, intent, sources, steps, sessionId: session.sessionId, lastCourse: course ? { id: course.id, code: course.code, name: course.name } : (session.lastCourseId ? { id: session.lastCourseId, name: session.lastCourseName } : null) };
  if (ctx.plan) out.plan = ctx.plan;
  return out;
}

function capabilities() {
  return {
    name: 'CourseHub 学习助手 Agent',
    engine: 'builtin',
    llmConfigured: Boolean(process.env.LLM_API_KEY && process.env.LLM_BASE_URL && process.env.LLM_MODEL),
    pipeline: ['意图识别', '实体抽取', '证据检索', '综合回答', '会话记忆'],
    intents: Object.keys(INTENT_LABEL),
    tools: [
      { name: 'retrieveCourses', desc: '按课程名 / 代码 / 教师 / 学院检索课程，按评分加权' },
      { name: 'retrieveMaterials', desc: '按标题 / 课程 / 类型检索学习资料，按下载量加权' },
      { name: 'retrieveQA', desc: '检索问答及已采纳回答，已采纳回答优先' },
      { name: 'retrieveTeachers', desc: '检索教师及主讲课程，按评分加权' },
      { name: 'retrieveReviews', desc: '检索已通过审核的学生评价，按点赞加权' },
      { name: 'retrieveGroups', desc: '检索学习小组（时间 / 地点 / 人数）' },
      { name: 'buildPlan', desc: '按课程资料与问答生成逐日复习计划' },
    ],
    endpoints: ['POST /api/agent/chat', 'GET /api/agent/sessions/:id', 'POST /api/agent/plan', 'GET /api/agent/capabilities'],
    notes: '内置引擎离线工作，回答只引用 server/data.json 中的真实数据；配置 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL 后可启用可选的大模型润色，失败时自动回退。',
  };
}

function clearSession(id) {
  if (!id || !Object.prototype.hasOwnProperty.call(sessions, id)) return false;
  delete sessions[id];
  persistSessions();
  return true;
}

module.exports = { chat, getSession, clearSession, buildPlan, capabilities, loadData };
