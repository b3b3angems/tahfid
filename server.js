const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));