const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// إعداد استقبال الصور (كشف التحضير الورقي) في الذاكرة مباشرة
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB كحد أقصى
});

const VALID_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// تهيئة قاعدة البيانات وتنظيف القيود القديمة
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        ring VARCHAR(50) NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        student_id INT REFERENCES students(id) ON DELETE CASCADE,
        status VARCHAR(20) DEFAULT 'unmarked',
        reason TEXT DEFAULT '',
        day_name VARCHAR(20) DEFAULT 'الأحد',
        year_num INT DEFAULT 1447,
        month_num INT DEFAULT 1,
        week_num INT DEFAULT 1
      );
    `);

    await pool.query(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS year_num INT DEFAULT 1447;`);
    await pool.query(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS month_num INT DEFAULT 1;`);
    await pool.query(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS week_num INT DEFAULT 1;`);

    // إسقاط القيد القديم المسبب للمشكلة إذا كان موجوداً
    await pool.query(`ALTER TABLE attendance DROP CONSTRAINT IF EXISTS unique_student_day;`);

    // إضافة القيد الجديد المعتمد على الأسبوع والشهر والسنة
    await pool.query(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'unique_student_hijri_period'
        ) THEN 
          ALTER TABLE attendance ADD CONSTRAINT unique_student_hijri_period UNIQUE (student_id, day_name, week_num, month_num, year_num);
        END IF;
      END $$;
    `);

    console.log('Database initialized and old constraints dropped successfully');
  } catch (err) {
    console.error('Error initializing DB:', err);
  }
}

initDB();

app.get('/', (req, res) => {
  const publicPath = path.join(__dirname, 'public', 'index.html');
  const rootPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(publicPath)) res.sendFile(publicPath);
  else if (fs.existsSync(rootPath)) res.sendFile(rootPath);
  else res.status(404).send('Index file not found');
});

// جلب الطلاب مع الحالات
app.get('/api/students', async (req, res) => {
  const day = req.query.day || 'الأحد';
  const year = parseInt(req.query.year) || 1447;
  const month = parseInt(req.query.month) || 1;
  const week = parseInt(req.query.week) || 1;

  try {
    const query = `
      SELECT s.id, s.name, s.ring, 
             COALESCE(a.status, 'unmarked') as status, 
             COALESCE(a.reason, '') as reason
      FROM students s
      LEFT JOIN attendance a 
        ON s.id = a.student_id 
       AND a.day_name = $1 
       AND a.year_num = $2 
       AND a.month_num = $3 
       AND a.week_num = $4
      ORDER BY s.id ASC
    `;
    const result = await pool.query(query, [day, year, month, week]);
    res.json(result.rows);
  } catch (err) { 
    console.error(err);
    res.status(500).send(err.message); 
  }
});

// إضافة طالب جديد
app.post('/api/students', async (req, res) => {
  const { name, ring, day, year, month, week } = req.body;
  const currentDay = day || 'الأحد';
  const y = parseInt(year) || 1447;
  const m = parseInt(month) || 1;
  const w = parseInt(week) || 1;

  try {
    const studentRes = await pool.query('INSERT INTO students (name, ring) VALUES ($1, $2) RETURNING *', [name, ring]);
    const student = studentRes.rows[0];
    
    await pool.query(
      `INSERT INTO attendance (student_id, day_name, year_num, month_num, week_num, status) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       ON CONFLICT (student_id, day_name, week_num, month_num, year_num) DO NOTHING`,
      [student.id, currentDay, y, m, w, 'unmarked']
    );
    res.json(student);
  } catch (err) { 
    console.error('Error adding student:', err);
    res.status(500).send(err.message); 
  }
});

// تحديث حالة الحضور فردياً
app.put('/api/attendance', async (req, res) => {
  const { student_id, day, year, month, week, status, reason } = req.body;
  const y = parseInt(year) || 1447;
  const m = parseInt(month) || 1;
  const w = parseInt(week) || 1;

  try {
    const query = `
      INSERT INTO attendance (student_id, day_name, year_num, month_num, week_num, status, reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (student_id, day_name, week_num, month_num, year_num) 
      DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason;
    `;
    await pool.query(query, [student_id, day, y, m, w, status, reason || '']);
    res.json({ success: true });
  } catch (err) { 
    console.error(err);
    res.status(500).send(err.message); 
  }
});

// تغيير الحضور جماعياً (تحضير الكل / إعادة ضبط لم يتم التحضير)
app.post('/api/attendance/all-status', async (req, res) => {
  const { ring, day, year, month, week, status } = req.body;
  const y = parseInt(year) || 1447;
  const m = parseInt(month) || 1;
  const w = parseInt(week) || 1;
  const newStatus = status || 'unmarked';

  try {
    const students = await pool.query('SELECT id FROM students WHERE ring = $1', [ring]);
    for (let s of students.rows) {
      await pool.query(`
        INSERT INTO attendance (student_id, day_name, year_num, month_num, week_num, status, reason)
        VALUES ($1, $2, $3, $4, $5, $6, '')
        ON CONFLICT (student_id, day_name, week_num, month_num, year_num) 
        DO UPDATE SET status = $6, reason = '';
      `, [s.id, day, y, m, w, newStatus]);
    }
    res.json({ success: true });
  } catch (err) { 
    console.error(err);
    res.status(500).send(err.message); 
  }
});

// حذف طالب
app.delete('/api/students/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM students WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { 
    console.error(err);
    res.status(500).send(err.message); 
  }
});

// جلب إحصائيات الشهر
app.get('/api/students/:id/stats', async (req, res) => {
  const studentId = req.params.id;
  const year = parseInt(req.query.year) || 1447;
  const month = parseInt(req.query.month) || 1;

  try {
    const statsQuery = `
      SELECT 
        COUNT(CASE WHEN status = 'absent' THEN 1 END) as absent_count,
        COUNT(CASE WHEN status = 'excused' THEN 1 END) as excused_count
      FROM attendance
      WHERE student_id = $1 AND year_num = $2 AND month_num = $3;
    `;
    const result = await pool.query(statsQuery, [studentId, year, month]);
    res.json(result.rows[0]);
  } catch (err) { 
    console.error(err);
    res.status(500).send(err.message); 
  }
});

// تحليل صورة كشف التحضير الورقي بالذكاء الاصطناعي
// يقرأ اليوم والأسبوع من رأس الصفحة (المطبوع بخط الكمبيوتر) ويحاول فهم علامات
// الصح/الخطأ أمام كل طالب. لا يتم حفظ أي شيء في قاعدة البيانات هنا؛ النتيجة
// تُعاد للمراجعة والتعديل من الواجهة قبل الحفظ الفعلي عبر /api/attendance/bulk-update
app.post('/api/attendance/scan', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم إرسال صورة' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'مفتاح الذكاء الاصطناعي (ANTHROPIC_API_KEY) غير معرّف على الخادم' });
    }

    const ring = req.body.ring || '';
    const studentsRes = await pool.query(
      'SELECT id, name FROM students WHERE ring = $1 ORDER BY id ASC',
      [ring]
    );
    const knownStudents = studentsRes.rows;

    const base64Image = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/jpeg';

    const promptText = `
أنت تحلل صورة فوتوغرافية لكشف تحضير ورقي لحلقة تحفيظ قرآن.

في أعلى الصفحة يوجد نص مطبوع بخط الكمبيوتر (وليس مكتوباً باليد) يوضح اسم اليوم ورقم الأسبوع. اقرأ هذا الجزء بعناية فائقة لأنه الأكثر وضوحاً.
اسم اليوم يجب أن يكون واحداً فقط من هذه القائمة بالضبط: "الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس".

كل صف في الجدول يمثل طالباً وبجانب اسمه علامة مكتوبة باليد:
- علامة صح (✓) تعني الحالة "present"
- علامة خطأ أو إكس (X ✗) تعني الحالة "absent"
- إذا كانت الخانة فارغة أو العلامة غير واضحة/غير مفهومة تماماً، اجعل الحالة "unmarked" (لا تخمّن)

قائمة الطلاب المعروفين حالياً في النظام (id, name) هي:
${JSON.stringify(knownStudents)}

طابق كل اسم مكتوب في الصورة مع أقرب اسم في القائمة أعلاه (حتى لو وُجد اختلاف بسيط في الكتابة أو الإملاء)، واستخدم رقم id الصحيح له من القائمة.
إن وجدت في الصورة اسماً لا يوجد له مطابقة معقولة في القائمة، أضفه كنص داخل unmatched_names ولا تضعه ضمن results.

أعد الإجابة بصيغة JSON فقط، بدون أي شرح أو نص إضافي وبدون علامات Markdown، بالشكل التالي بالضبط:
{
  "day": "اسم اليوم كما ظهر في الصورة أو null إذا لم يكن واضحاً",
  "week": رقم الأسبوع كرقم صحيح أو null إذا لم يكن واضحاً,
  "results": [ { "student_id": رقم الـ id, "status": "present" أو "absent" أو "unmarked" } ],
  "unmatched_names": ["اسم غير مطابق 1", "اسم غير مطابق 2"]
}
`.trim();

    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
              { type: 'text', text: promptText }
            ]
          }
        ]
      })
    });

    const aiData = await aiResponse.json();

    if (aiData.error) {
      console.error('Anthropic API error:', aiData.error);
      return res.status(500).json({ error: 'خطأ من خدمة الذكاء الاصطناعي: ' + aiData.error.message });
    }

    const textBlock = (aiData.content || []).find(c => c.type === 'text');
    if (!textBlock) {
      return res.status(500).json({ error: 'لم يتم استلام رد نصي من الذكاء الاصطناعي' });
    }

    const cleaned = textBlock.text
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '');

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('Failed to parse AI JSON response:', cleaned);
      return res.status(500).json({ error: 'تعذر فهم رد الذكاء الاصطناعي، حاول بصورة أوضح' });
    }

    const nameById = {};
    knownStudents.forEach(s => { nameById[s.id] = s.name; });

    const results = (Array.isArray(parsed.results) ? parsed.results : [])
      .filter(r => r && nameById[r.student_id])
      .map(r => ({
        student_id: r.student_id,
        name: nameById[r.student_id],
        status: ['present', 'absent', 'excused', 'unmarked'].includes(r.status) ? r.status : 'unmarked'
      }));

    const detectedDay = VALID_DAYS.includes(parsed.day) ? parsed.day : null;
    const detectedWeek = Number.isInteger(parsed.week) ? parsed.week : (parseInt(parsed.week) || null);

    res.json({
      day: detectedDay,
      week: detectedWeek,
      results,
      unmatched_names: Array.isArray(parsed.unmatched_names) ? parsed.unmatched_names : []
    });
  } catch (err) {
    console.error('Error scanning attendance sheet:', err);
    res.status(500).send(err.message);
  }
});

// حفظ دفعة من حالات التحضير بعد مراجعتها (تُستخدم بعد المسح بالذكاء الاصطناعي)
app.post('/api/attendance/bulk-update', async (req, res) => {
  const { day, year, month, week, updates } = req.body;
  const y = parseInt(year) || 1447;
  const m = parseInt(month) || 1;
  const w = parseInt(week) || 1;
  const list = Array.isArray(updates) ? updates : [];

  try {
    for (const u of list) {
      await pool.query(`
        INSERT INTO attendance (student_id, day_name, year_num, month_num, week_num, status, reason)
        VALUES ($1, $2, $3, $4, $5, $6, '')
        ON CONFLICT (student_id, day_name, week_num, month_num, year_num)
        DO UPDATE SET status = EXCLUDED.status, reason = '';
      `, [u.student_id, day, y, m, w, ['present', 'absent', 'excused', 'unmarked'].includes(u.status) ? u.status : 'unmarked']);
    }
    res.json({ success: true, updated: list.length });
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));