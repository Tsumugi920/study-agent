# CourseHub 学习助手 Agent — 校园课程评价与学习资料平台 + 学习助手

Node.js + Express 全栈项目，数据持久化在 `server/data.json`（JSON 文件，无外部数据库）。
在原有课程评价平台之上增加了 **CourseHub 学习助手 Agent**：意图识别 → 实体抽取 →
证据检索 → 综合回答，回答只引用平台数据，不编造事实。

## 学习助手 Agent

- 聊天入口：首页顶部「🤖 学习助手」链接，或导航栏「🤖 学习助手」标签页
- 对话接口：`POST /api/agent/chat`（`{sessionId, message}` → `{reply, intent, sources[], steps[]}`）
- 复习计划：`POST /api/agent/plan`（`{courseId, days}` → 逐日计划）；页面上有“生成复习计划”表单
- 会话查询：`GET /api/agent/sessions/:id`；能力说明：`GET /api/agent/capabilities`

### 架构（意图 → 检索 → 综合）

1. **意图识别**：关键词打分，把中文提问分到 选课咨询 / 资料查找 / 考试复习 / 老师评价 / 学习计划 / 闲聊兜底 六类（重叠意图按 学习计划 > 考试复习 > 资料查找 > 老师评价 > 选课咨询 的优先级判定）。
2. **实体抽取**：课程代码（如 CS201）或课程全名、教师姓名、学分（“3 学分的课”）、备考天数（“7 天”）。
3. **证据检索**：对问题分词（中文词 + 二字 gram）后在 `data.json` 上打分检索：课程（按评分加权）、资料（按下载量加权）、问答（已采纳回答优先）、教师（按评分加权）、已通过审核的评价（按点赞加权）、学习小组。
4. **综合回答**：按意图用模板综合，只写证据里有的内容，并逐条列出证据来源（课程代码 + 名称、资料标题、采纳回答原文、评价原文）。找不到匹配内容时直接说不知道，并给出最接近的替代项。
5. **会话记忆**：按 `sessionId` 记住上文提到的课程，追问如“那门课难吗”能自动指代；对话历史持久化在 `server/agent-sessions.json`（与种子数据 `data.json` 分开，互不干扰）。

### 内置引擎 vs 可选 LLM

- **内置引擎（默认，离线可用）**：不需要任何 key，完全基于平台数据回答。
- **可选 LLM 适配器**：设置环境变量 `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL` 后，对话会把检索到的证据交给 OpenAI 兼容接口做语言润色；证据和来源保持不变，调用失败或未配置时自动回退到内置引擎。不内置任何 key、地址或假回答。

### 示例问题与预期回答

- “数据结构难吗？”→ 选课咨询：CS201 数据结构与算法（李晓梅，4 学分，评分 4.8），已审核评价的平均难度 / 负担，附两条同学评价原文。
- “推荐一门 3 学分的课”→ 按评分推荐 3 门 3 学分课（机器学习导论 4.9、数据库系统 4.5、微观经济学 4.3）。
- “数据结构期末会考红黑树吗？”→ 考试复习：引用问答区已采纳回答（李晓梅：往年期末红黑树只考插入，不考删除，重点看 AVL 树的旋转）及相关真题资料。
- “李晓梅老师怎么样？”→ 教师评价：职称、评分、主讲课程，附学生评价原文。
- “帮我做一份 7 天复习计划”→ 先问是哪门课；指定课程后按该课资料、真题、已采纳问答排逐日计划，并推荐相关学习小组。

## 运行

```bash
npm install
npm start
# 服务运行在 http://localhost:3032
```

首页：`/`（课程 / 评价 / 资料 / 问答 / 学习小组 / 教师 / 收藏，多视图前端）
管理后台：`/admin.html`（数据统计、评价审核通过/驳回、删除评价与课程）

## 数据（每类 12 条种子数据）

- courses（课程）：课程代码、名称、教师、学院、学分、学期、评分均值
- reviews（评价）：评分 1–5、难度、负担、评语、点赞、审核状态
- materials（资料）：标题、所属课程、类型（课件/笔记/真题/习题/其他）、上传者、下载量、大小
- questions（问答）：标题、内容、所属课程、状态（open/answered/closed）
- answers（回答）：挂在问题下，可采纳为最佳答案
- studyGroups（学习小组）：课程、时间、地点、人数上限、成员
- teachers（教师）：姓名、学院、职称、邮箱、评分
- collections（收藏）：用户收藏的课程或资料

## API（42 个端点 + 学习助手 4 个端点）

- `GET /api/health`
- `GET /api/search?q=关键词`（课程 + 资料 + 教师 + 问题）
- 课程：`GET /api/courses`（department/semester/teacher/minRating 过滤，q 搜索，rating_desc/credits_desc/newest 排序，page/size 分页）、`GET /api/courses/:id`（含该课评价、资料、问题）、`POST /api/courses`、`PUT /api/courses/:id`、`DELETE /api/courses/:id`
- 评价：`GET /api/reviews`（courseId/status/minRating/q 过滤，likes_desc/rating_desc 排序）、`GET /api/reviews/:id`、`POST /api/reviews`、`PUT /api/reviews/:id`、`DELETE /api/reviews/:id`、`POST /api/reviews/:id/like`
- 资料：`GET /api/materials`（courseId/type/q 过滤，downloads_desc 排序）、`GET /api/materials/:id`、`POST /api/materials`、`PUT /api/materials/:id`、`DELETE /api/materials/:id`、`POST /api/materials/:id/download`
- 问答：`GET /api/questions`、`GET /api/questions/:id`（含回答）、`POST /api/questions`、`PUT /api/questions/:id`、`DELETE /api/questions/:id`、`POST /api/questions/:id/answers`、`PUT /api/answers/:id`、`POST /api/answers/:id/accept`
- 学习小组：`GET /api/study-groups`、`GET /api/study-groups/:id`、`POST /api/study-groups`、`PUT /api/study-groups/:id`、`DELETE /api/study-groups/:id`、`POST /api/study-groups/:id/join`、`POST /api/study-groups/:id/leave`
- 教师：`GET /api/teachers`（department/q 过滤，rating_desc 排序）、`GET /api/teachers/:id`（含所授课程）、`POST /api/teachers`、`PUT /api/teachers/:id`、`DELETE /api/teachers/:id`
- 收藏：`GET /api/collections`（user/kind 过滤）、`POST /api/collections`、`DELETE /api/collections/:id`
- 学习助手 Agent：`POST /api/agent/chat`、`GET /api/agent/sessions/:id`、`POST /api/agent/plan`、`GET /api/agent/capabilities`

## 校验规则

- 评价 rating/difficulty/workload 必须是 1–5 的整数，否则 400；课程不存在时 404
- 课程代码重复 → 409；学分须为 0–10 的数字，否则 400
- 资料 type 必须是 课件/笔记/真题/习题/其他，否则 400
- 评价 status 只能是 pending/approved/rejected；问题 status 只能是 open/answered/closed
- 学习小组重复加入 → 409；小组满员 → 409；容量小于现有人数时改容量 → 409；退出非成员 → 404
- 收藏重复 → 409；收藏 kind 只能是 course/material
- PUT 只允许白名单字段，id/createdAt 不可修改
- 不存在的资源 → 404
