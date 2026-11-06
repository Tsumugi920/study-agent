// Course Hub — 校园课程评价与学习资料平台
// Node.js + Express, data persisted in server/data.json, no database.
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = Number(process.env.PORT) || 3032;
const DATA = path.join(__dirname, 'data.json');
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function load() { return JSON.parse(fs.readFileSync(DATA, 'utf8')); }
function save(d) { fs.writeFileSync(DATA, JSON.stringify(d, null, 2)); }
function nextId(list) { return list.length ? Math.max(...list.map(x => x.id)) + 1 : 1; }
function page(list, q) {
  const p = Math.max(1, Number(q.page) || 1), s = Math.min(50, Number(q.size) || 20);
  return { total: list.length, page: p, size: s, items: list.slice((p - 1) * s, p * s) };
}
function validRating(v) { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 5; }
function validNonNeg(v) { const n = Number(v); return Number.isFinite(n) && n >= 0; }
function applyPut(x, body, allowed, coerce) {
  allowed.forEach(f => {
    if (body[f] !== undefined) x[f] = coerce && coerce[f] ? coerce[f](body[f]) : body[f];
  });
}
function notFound(res) { return res.status(404).json({ error: 'not found' }); }

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'course-hub', port: PORT }));

// ---- Search (courses + materials + teachers + questions) ----
app.get('/api/search', (req, res) => {
  const d = load(); const q = (req.query.q || '').trim();
  if (!q) return res.json({ q, courses: [], materials: [], teachers: [], questions: [] });
  const has = s => (s || '').includes(q);
  res.json({
    q,
    courses: d.courses.filter(c => has(c.name) || has(c.code) || has(c.teacher) || has(c.department)),
    materials: d.materials.filter(m => has(m.title) || has(m.course) || has(m.type)),
    teachers: d.teachers.filter(t => has(t.name) || has(t.department)),
    questions: d.questions.filter(x => has(x.title) || has(x.content) || has(x.course))
  });
});

// ---- Courses ----
app.get('/api/courses', (req, res) => {
  const d = load(); let out = d.courses;
  if (req.query.department) out = out.filter(x => x.department === req.query.department);
  if (req.query.semester) out = out.filter(x => x.semester === req.query.semester);
  if (req.query.teacher) out = out.filter(x => x.teacher === req.query.teacher);
  if (req.query.q) out = out.filter(x => (x.name + x.code + x.teacher).includes(req.query.q));
  if (req.query.minRating) out = out.filter(x => Number(x.rating) >= Number(req.query.minRating));
  if (req.query.sort === 'rating_desc') out = [...out].sort((a, b) => b.rating - a.rating);
  if (req.query.sort === 'credits_desc') out = [...out].sort((a, b) => b.credits - a.credits);
  if (req.query.sort === 'newest') out = [...out].sort((a, b) => b.id - a.id);
  res.json(page(out, req.query));
});
app.get('/api/courses/:id', (req, res) => {
  const d = load(); const x = d.courses.find(i => i.id === Number(req.params.id));
  if (!x) return notFound(res);
  res.json({
    ...x,
    reviews: d.reviews.filter(r => r.courseId === x.id),
    materials: d.materials.filter(m => m.courseId === x.id),
    questions: d.questions.filter(q => q.courseId === x.id)
  });
});
app.post('/api/courses', (req, res) => {
  const d = load(); const { code, name, teacher, department, credits, semester } = req.body;
  if (!code || !name || !teacher || !department) return res.status(400).json({ error: 'code, name, teacher, department required' });
  if (credits !== undefined && (!validNonNeg(credits) || Number(credits) > 10)) return res.status(400).json({ error: 'credits must be a number 0-10' });
  if (d.courses.some(c => c.code === code)) return res.status(409).json({ error: 'course code already exists' });
  const x = { id: nextId(d.courses), code, name, teacher, department, credits: Number(credits) || 2, semester: semester || '2026春', rating: 0, reviewCount: 0, createdAt: new Date().toISOString().slice(0, 10) };
  d.courses.push(x); save(d); res.status(201).json(x);
});
app.put('/api/courses/:id', (req, res) => {
  const d = load(); const x = d.courses.find(i => i.id === Number(req.params.id));
  if (!x) return notFound(res);
  if (req.body.credits !== undefined && (!validNonNeg(req.body.credits) || Number(req.body.credits) > 10)) return res.status(400).json({ error: 'credits must be a number 0-10' });
  applyPut(x, req.body, ['code', 'name', 'teacher', 'department', 'credits', 'semester'], { credits: Number });
  save(d); res.json(x);
});
app.delete('/api/courses/:id', (req, res) => {
  const d = load(); const i = d.courses.findIndex(x => x.id === Number(req.params.id));
  if (i < 0) return notFound(res);
  d.courses.splice(i, 1); save(d); res.json({ ok: true });
});

// ---- Reviews ----
app.get('/api/reviews', (req, res) => {
  const d = load(); let out = d.reviews;
  if (req.query.courseId) out = out.filter(x => x.courseId === Number(req.query.courseId));
  if (req.query.status) out = out.filter(x => x.status === req.query.status);
  if (req.query.minRating) out = out.filter(x => x.rating >= Number(req.query.minRating));
  if (req.query.q) out = out.filter(x => (x.comment || '').includes(req.query.q));
  if (req.query.sort === 'likes_desc') out = [...out].sort((a, b) => b.likes - a.likes);
  if (req.query.sort === 'rating_desc') out = [...out].sort((a, b) => b.rating - a.rating);
  res.json(page(out, req.query));
});
app.get('/api/reviews/:id', (req, res) => {
  const d = load(); const x = d.reviews.find(i => i.id === Number(req.params.id));
  if (!x) return notFound(res); res.json(x);
});
app.post('/api/reviews', (req, res) => {
  const d = load(); const { courseId, author, rating, difficulty, workload, comment } = req.body;
  if (!courseId || !author || rating === undefined) return res.status(400).json({ error: 'courseId, author, rating required' });
  if (!d.courses.some(c => c.id === Number(courseId))) return res.status(404).json({ error: 'course not found' });
  if (!validRating(rating)) return res.status(400).json({ error: 'rating must be an integer 1-5' });
  if (difficulty !== undefined && !validRating(difficulty)) return res.status(400).json({ error: 'difficulty must be an integer 1-5' });
  if (workload !== undefined && !validRating(workload)) return res.status(400).json({ error: 'workload must be an integer 1-5' });
  const x = { id: nextId(d.reviews), courseId: Number(courseId), author, rating: Number(rating), difficulty: Number(difficulty) || 3, workload: Number(workload) || 3, comment: comment || '', likes: 0, status: 'pending', createdAt: new Date().toISOString().slice(0, 10) };
  d.reviews.push(x);
  const rs = d.reviews.filter(r => r.courseId === x.courseId);
  const c = d.courses.find(c => c.id === x.courseId);
  c.rating = Math.round(rs.reduce((s, r) => s + r.rating, 0) / rs.length * 10) / 10; c.reviewCount = rs.length;
  save(d); res.status(201).json(x);
});
app.put('/api/reviews/:id', (req, res) => {
  const d = load(); const x = d.reviews.find(i => i.id === Number(req.params.id));
  if (!x) return notFound(res);
  if (req.body.rating !== undefined && !validRating(req.body.rating)) return res.status(400).json({ error: 'rating must be an integer 1-5' });
  if (req.body.difficulty !== undefined && !validRating(req.body.difficulty)) return res.status(400).json({ error: 'difficulty must be an integer 1-5' });
  if (req.body.status !== undefined && !['pending', 'approved', 'rejected'].includes(req.body.status)) return res.status(400).json({ error: 'status must be pending/approved/rejected' });
  applyPut(x, req.body, ['rating', 'difficulty', 'workload', 'comment', 'status'], { rating: Number, difficulty: Number, workload: Number });
  save(d); res.json(x);
});
app.delete('/api/reviews/:id', (req, res) => {
  const d = load(); const i = d.reviews.findIndex(x => x.id === Number(req.params.id));
  if (i < 0) return notFound(res); d.reviews.splice(i, 1); save(d); res.json({ ok: true });
});
app.post('/api/reviews/:id/like', (req, res) => {
  const d = load(); const x = d.reviews.find(i => i.id === Number(req.params.id));
  if (!x) return notFound(res); x.likes += 1; save(d); res.json(x);
});

// ---- Materials ----
app.get('/api/materials', (req, res) => {
  const d = load(); let out = d.materials;
  if (req.query.courseId) out = out.filter(x => x.courseId === Number(req.query.courseId));
  if (req.query.type) out = out.filter(x => x.type === req.query.type);
  if (req.query.q) out = out.filter(x => (x.title + x.course).includes(req.query.q));
  if (req.query.sort === 'downloads_desc') out = [...out].sort((a, b) => b.downloads - a.downloads);
  res.json(page(out, req.query));
});
app.get('/api/materials/:id', (req, res) => {
  const d = load(); const x = d.materials.find(i => i.id === Number(req.params.id));
  if (!x) return notFound(res); res.json(x);
});
app.post('/api/materials', (req, res) => {
  const d = load(); const { title, course, courseId, type, uploader, size } = req.body;
  if (!title || !type || !uploader) return res.status(400).json({ error: 'title, type, uploader required' });
  if (!['课件', '笔记', '真题', '习题', '其他'].includes(type)) return res.status(400).json({ error: 'type must be 课件/笔记/真题/习题/其他' });
  const x = { id: nextId(d.materials), title, course: course || '', courseId: Number(courseId) || null, type, uploader, size: size || '1.2 MB', downloads: 0, createdAt: new Date().toISOString().slice(0, 10) };
  d.materials.push(x); save(d); res.status(201).json(x);
});
app.put('/api/materials/:id', (req, res) => {
  const d = load(); const x = d.materials.find(i => i.id === Number(req.params.id));
  if (!x) return notFound(res);
  if (req.body.type !== undefined && !['课件', '笔记', '真题', '习题', '其他'].includes(req.body.type)) return res.status(400).json({ error: 'type must be 课件/笔记/真题/习题/其他' });
  applyPut(x, req.body, ['title', 'course', 'courseId', 'type', 'uploader', 'size'], { courseId: Number });
  save(d); res.json(x);
});
app.delete('/api/materials/:id', (req, res) => {
  const d = load(); const i = d.materials.findIndex(x => x.id === Number(req.params.id));
  if (i < 0) return notFound(res); d.materials.splice(i, 1); save(d); res.json({ ok: true });
});
app.post('/api/materials/:id/download', (req, res) => {
  const d = load(); const x = d.materials.find(i => i.id === Number(req.params.id));
  if (!x) return notFound(res); x.downloads += 1; save(d); res.json(x);
});

// ---- Questions & answers ----
app.get('/api/questions', (req, res) => {
  const d = load(); let out = d.questions;
  if (req.query.courseId) out = out.filter(x => x.courseId === Number(req.query.courseId));
  if (req.query.status) out = out.filter(x => x.status === req.query.status);
  if (req.query.q) out = out.filter(x => (x.title + x.content).includes(req.query.q));
  if (req.query.sort === 'newest') out = [...out].sort((a, b) => b.id - a.id);
  res.json(page(out, req.query));
});
app.get('/api/questions/:id', (req, res) => {
  const d = load(); const x = d.questions.find(i => i.id === Number(req.params.id));
  if (!x) return notFound(res);
  res.json({ ...x, answers: d.answers.filter(a => a.questionId === x.id) });
});
app.post('/api/questions', (req, res) => {
  const d = load(); const { title, content, course, courseId, author } = req.body;
  if (!title || !author) return res.status(400).json({ error: 'title, author required' });
  const x = { id: nextId(d.questions), title, content: content || '', course: course || '', courseId: Number(courseId) || null, author, status: 'open', createdAt: new Date().toISOString().slice(0, 10) };
  d.questions.push(x); save(d); res.status(201).json(x);
});
app.put('/api/questions/:id', (req, res) => {
  const d = load(); const x = d.questions.find(i => i.id === Number(req.params.id));
  if (!x) return notFound(res);
  if (req.body.status !== undefined && !['open', 'answered', 'closed'].includes(req.body.status)) return res.status(400).json({ error: 'status must be open/answered/closed' });
  applyPut(x, req.body, ['title', 'content', 'course', 'courseId', 'status'], { courseId: Number });
  save(d); res.json(x);
});
app.delete('/api/questions/:id', (req, res) => {
  const d = load(); const i = d.questions.findIndex(x => x.id === Number(req.params.id));
  if (i < 0) return notFound(res); d.questions.splice(i, 1); save(d); res.json({ ok: true });
});
app.post('/api/questions/:id/answers', (req, res) => {
  const d = load(); const q = d.questions.find(x => x.id === Number(req.params.id));
  if (!q) return notFound(res);
  if (!req.body.author || !req.body.content) return res.status(400).json({ error: 'author, content required' });
  const a = { id: nextId(d.answers), questionId: q.id, author: req.body.author, content: req.body.content, accepted: false, likes: 0, createdAt: new Date().toISOString().slice(0, 10) };
  d.answers.push(a); q.status = 'answered'; save(d); res.status(201).json(a);
});
app.put('/api/answers/:id', (req, res) => {
  const d = load(); const a = d.answers.find(x => x.id === Number(req.params.id));
  if (!a) return notFound(res);
  applyPut(a, req.body, ['content']);
  save(d); res.json(a);
});
app.post('/api/answers/:id/accept', (req, res) => {
  const d = load(); const a = d.answers.find(x => x.id === Number(req.params.id));
  if (!a) return notFound(res);
  d.answers.filter(x => x.questionId === a.questionId).forEach(x => { x.accepted = false; });
  a.accepted = true;
  const q = d.questions.find(x => x.id === a.questionId); if (q) q.status = 'answered';
  save(d); res.json(a);
});

// ---- Study groups ----
app.get('/api/study-groups', (req, res) => {
  const d = load(); let out = d.studyGroups;
  if (req.query.courseId) out = out.filter(x => x.courseId === Number(req.query.courseId));
  if (req.query.q) out = out.filter(x => (x.name + x.course + x.place).includes(req.query.q));
  res.json(page(out, req.query));
});
app.get('/api/study-groups/:id', (req, res) => {
  const d = load(); const x = d.studyGroups.find(i => i.id === Number(req.params.id));
  if (!x) return notFound(res); res.json(x);
});
app.post('/api/study-groups', (req, res) => {
  const d = load(); const { name, course, courseId, time, place, capacity, creator } = req.body;
  if (!name || !course) return res.status(400).json({ error: 'name, course required' });
  if (capacity !== undefined && (!Number.isInteger(Number(capacity)) || Number(capacity) <= 0)) return res.status(400).json({ error: 'capacity must be a positive integer' });
  const x = { id: nextId(d.studyGroups), name, course, courseId: Number(courseId) || null, time: time || '', place: place || '', capacity: Number(capacity) || 10, members: creator ? [creator] : [], creator: creator || '匿名', createdAt: new Date().toISOString().slice(0, 10) };
  d.studyGroups.push(x); save(d); res.status(201).json(x);
});
app.put('/api/study-groups/:id', (req, res) => {
  const d = load(); const x = d.studyGroups.find(i => i.id === Number(req.params.id));
  if (!x) return notFound(res);
  if (req.body.capacity !== undefined && (!Number.isInteger(Number(req.body.capacity)) || Number(req.body.capacity) <= 0)) return res.status(400).json({ error: 'capacity must be a positive integer' });
  if (req.body.capacity !== undefined && Number(req.body.capacity) < x.members.length) return res.status(409).json({ error: 'capacity below current members' });
  applyPut(x, req.body, ['name', 'course', 'courseId', 'time', 'place', 'capacity'], { courseId: Number, capacity: Number });
  save(d); res.json(x);
});
app.delete('/api/study-groups/:id', (req, res) => {
  const d = load(); const i = d.studyGroups.findIndex(x => x.id === Number(req.params.id));
  if (i < 0) return notFound(res); d.studyGroups.splice(i, 1); save(d); res.json({ ok: true });
});
app.post('/api/study-groups/:id/join', (req, res) => {
  const d = load(); const x = d.studyGroups.find(i => i.id === Number(req.params.id));
  if (!x) return notFound(res);
  const name = req.body.name || '匿名';
  if (x.members.includes(name)) return res.status(409).json({ error: 'already joined' });
  if (x.members.length >= x.capacity) return res.status(409).json({ error: 'group full' });
  x.members.push(name); save(d); res.status(201).json(x);
});
app.post('/api/study-groups/:id/leave', (req, res) => {
  const d = load(); const x = d.studyGroups.find(i => i.id === Number(req.params.id));
  if (!x) return notFound(res);
  const name = req.body.name || '匿名';
  const i = x.members.indexOf(name);
  if (i < 0) return res.status(404).json({ error: 'not a member' });
  x.members.splice(i, 1); save(d); res.json(x);
});

// ---- Teachers ----
app.get('/api/teachers', (req, res) => {
  const d = load(); let out = d.teachers;
  if (req.query.department) out = out.filter(x => x.department === req.query.department);
  if (req.query.q) out = out.filter(x => (x.name + x.department).includes(req.query.q));
  if (req.query.sort === 'rating_desc') out = [...out].sort((a, b) => b.rating - a.rating);
  res.json(page(out, req.query));
});
app.get('/api/teachers/:id', (req, res) => {
  const d = load(); const x = d.teachers.find(i => i.id === Number(req.params.id));
  if (!x) return notFound(res);
  res.json({ ...x, courses: d.courses.filter(c => c.teacher === x.name) });
});
app.post('/api/teachers', (req, res) => {
  const d = load(); const { name, department, title, email } = req.body;
  if (!name || !department) return res.status(400).json({ error: 'name, department required' });
  if (req.body.rating !== undefined && !validRating(req.body.rating)) return res.status(400).json({ error: 'rating must be an integer 1-5' });
  const x = { id: nextId(d.teachers), name, department, title: title || '讲师', email: email || '', rating: Number(req.body.rating) || 4, courses: req.body.courses || [], createdAt: new Date().toISOString().slice(0, 10) };
  d.teachers.push(x); save(d); res.status(201).json(x);
});
app.put('/api/teachers/:id', (req, res) => {
  const d = load(); const x = d.teachers.find(i => i.id === Number(req.params.id));
  if (!x) return notFound(res);
  if (req.body.rating !== undefined && !validRating(req.body.rating)) return res.status(400).json({ error: 'rating must be an integer 1-5' });
  applyPut(x, req.body, ['name', 'department', 'title', 'email', 'rating', 'courses'], { rating: Number });
  save(d); res.json(x);
});
app.delete('/api/teachers/:id', (req, res) => {
  const d = load(); const i = d.teachers.findIndex(x => x.id === Number(req.params.id));
  if (i < 0) return notFound(res); d.teachers.splice(i, 1); save(d); res.json({ ok: true });
});

// ---- Collections (bookmarks) ----
app.get('/api/collections', (req, res) => {
  const d = load(); let out = d.collections;
  if (req.query.user) out = out.filter(x => x.user === req.query.user);
  if (req.query.kind) out = out.filter(x => x.kind === req.query.kind);
  res.json(page(out, req.query));
});
app.post('/api/collections', (req, res) => {
  const d = load(); const { user, kind, targetId, note } = req.body;
  if (!user || !kind || targetId === undefined) return res.status(400).json({ error: 'user, kind, targetId required' });
  if (!['course', 'material'].includes(kind)) return res.status(400).json({ error: 'kind must be course/material' });
  if (d.collections.some(c => c.user === user && c.kind === kind && c.targetId === Number(targetId))) return res.status(409).json({ error: 'already collected' });
  const x = { id: nextId(d.collections), user, kind, targetId: Number(targetId), note: note || '', createdAt: new Date().toISOString().slice(0, 10) };
  d.collections.push(x); save(d); res.status(201).json(x);
});
app.delete('/api/collections/:id', (req, res) => {
  const d = load(); const i = d.collections.findIndex(x => x.id === Number(req.params.id));
  if (i < 0) return notFound(res); d.collections.splice(i, 1); save(d); res.json({ ok: true });
});

// ---- 学习助手 Agent (CourseHub 学习助手) ----
const agent = require('./agent');
app.post('/api/agent/chat', async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'message required' });
  try { res.json(await agent.chat(sessionId || 'default', message)); }
  catch (e) { res.status(500).json({ error: 'agent failed' }); }
});
app.get('/api/agent/sessions/:id', (req, res) => {
  res.json(agent.getSession(req.params.id));
});
app.post('/api/agent/plan', (req, res) => {
  const d = agent.loadData();
  const { courseId, days } = req.body || {};
  if (!courseId) return res.status(400).json({ error: 'courseId required' });
  const plan = agent.buildPlan(d, courseId, days || 7);
  if (!plan) return res.status(404).json({ error: 'course not found' });
  res.json(plan);
});
app.get('/api/agent/capabilities', (req, res) => res.json(agent.capabilities()));

app.listen(PORT, () => console.log('course-hub listening on ' + PORT));
