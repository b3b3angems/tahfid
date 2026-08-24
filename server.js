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

// إنشاء جداول الطلاب وسجلات الحضور اليومية
pool.query(`
  CREATE TABLE IF NOT EXISTS students (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    ring VARCHAR(50) NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id SERIAL PRIMARY KEY,
    student_id INT REFERENCES students(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    status VARCHAR(20) DEFAULT 'present',
    reason TEXT DEFAULT '',
    UNIQUE(student_id, date)
  );
`);

// الصفحة الرئيسية
app.get('/', (req, res) => {
  const publicPath = path.join(__dirname, 'public', 'index.html');
  const rootPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(publicPath)) res.sendFile(publicPath);
  else if (fs.existsSync(rootPath)) res.sendFile(rootPath);
  else res.status(404).send('Index file not found');
});

// جلب قائمة الطلاب بحسب التاريخ المحدد
app.get('/api/students', async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  try {
    const query = `
      SELECT s.id, s.name, s.ring, 
             COALESCE(a.status, 'present') as status, 
             COALESCE(a.reason, '') as reason
      FROM students s
      LEFT JOIN attendance a ON s.id = a.student_id AND a.date = $1
      ORDER BY s.id ASC
    `;
    const result = await pool.query(query, [date]);
    res.json(result.rows);
  } catch (err) { res.status(500).send(err.message); }
});

// إضافة طالب جديد
app.post('/api/students', async (req, res) => {
  const { name, ring, date } = req.body;
  const currentDate = date || new Date().toISOString().split('T')[0];
  try {
    const studentRes = await pool.query('INSERT INTO students (name, ring) VALUES ($1, $2) RETURNING *', [name, ring]);
    const student = studentRes.rows[0];
    await pool.query('INSERT INTO attendance (student_id, date, status) VALUES ($1, $2, $3)', [student.id, currentDate, 'present']);
    res.json(student);
  } catch (err) { res.status(500).send(err.message); }
});

// تحديث حالة الحضور والسبب
app.put('/api/attendance', async (req, res) => {
  const { student_id, date, status, reason } = req.body;
  try {
    const query = `
      INSERT INTO attendance (student_id, date, status, reason)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (student_id, date) 
      DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason;
    `;
    await pool.query(query, [student_id, date, status, reason || '']);
    res.json({ success: true });
  } catch (err) { res.status(500).send(err.message); }
});

// تحضير جميع الطلاب بـ "حاضر" ليوم معين
app.post('/api/attendance/all-present', async (req, res) => {
  const { ring, date } = req.body;
  try {
    const students = await pool.query('SELECT id FROM students WHERE ring = $1', [ring]);
    for (let s of students.rows) {
      await pool.query(`
        INSERT INTO attendance (student_id, date, status, reason)
        VALUES ($1, $2, 'present', '')
        ON CONFLICT (student_id, date) DO UPDATE SET status = 'present';
      `, [s.id, date]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).send(err.message); }
});

// حذف طالب
app.delete('/api/students/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM students WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).send(err.message); }
});

// جلب إحصائيات الأسبوع والشهر للطالب
app.get('/api/students/:id/stats', async (req, res) => {
  const studentId = req.params.id;
  try {
    const statsQuery = `
      SELECT 
        COUNT(CASE WHEN status = 'absent' AND date >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as absent_week,
        COUNT(CASE WHEN status = 'absent' AND date >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as absent_month,
        COUNT(CASE WHEN status = 'excused' AND date >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as excused_week,
        COUNT(CASE WHEN status = 'excused' AND date >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as excused_month
      FROM attendance
      WHERE student_id = $1;
    `;
    const result = await pool.query(statsQuery, [studentId]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).send(err.message); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));