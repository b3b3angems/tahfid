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

// تهيئة وقواعد البيانات وإضافة الأعمدة الناقصة تلقائياً
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
        status VARCHAR(20) DEFAULT 'present',
        reason TEXT DEFAULT ''
      );
    `);

    // إضافة عمود day_name لجدول attendance في حال عدم وجوده
    await pool.query(`
      ALTER TABLE attendance ADD COLUMN IF NOT EXISTS day_name VARCHAR(20) DEFAULT 'الأحد';
    `);

    // التأكد من وجود الشرط الفريد للطلاب واليوم
    await pool.query(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'unique_student_day'
        ) THEN 
          ALTER TABLE attendance ADD CONSTRAINT unique_student_day UNIQUE (student_id, day_name);
        END IF;
      END $$;
    `);

    console.log('Database synced successfully');
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

// جلب الطلاب بحسب اليوم المحدد
app.get('/api/students', async (req, res) => {
  const day = req.query.day || 'الأحد';
  try {
    const query = `
      SELECT s.id, s.name, s.ring, 
             COALESCE(a.status, 'present') as status, 
             COALESCE(a.reason, '') as reason
      FROM students s
      LEFT JOIN attendance a ON s.id = a.student_id AND a.day_name = $1
      ORDER BY s.id ASC
    `;
    const result = await pool.query(query, [day]);
    res.json(result.rows);
  } catch (err) { 
    console.error(err);
    res.status(500).send(err.message); 
  }
});

// إضافة طالب جديد
app.post('/api/students', async (req, res) => {
  const { name, ring, day } = req.body;
  const currentDay = day || 'الأحد';
  try {
    const studentRes = await pool.query('INSERT INTO students (name, ring) VALUES ($1, $2) RETURNING *', [name, ring]);
    const student = studentRes.rows[0];
    await pool.query(
      'INSERT INTO attendance (student_id, day_name, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [student.id, currentDay, 'present']
    );
    res.json(student);
  } catch (err) { 
    console.error(err);
    res.status(500).send(err.message); 
  }
});

// تحديث حالة الحضور والسبب
app.put('/api/attendance', async (req, res) => {
  const { student_id, day, status, reason } = req.body;
  try {
    const query = `
      INSERT INTO attendance (student_id, day_name, status, reason)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (student_id, day_name) 
      DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason;
    `;
    await pool.query(query, [student_id, day, status, reason || '']);
    res.json({ success: true });
  } catch (err) { 
    console.error(err);
    res.status(500).send(err.message); 
  }
});

// تحضير الجميع "حاضر" لليوم المحدد
app.post('/api/attendance/all-present', async (req, res) => {
  const { ring, day } = req.body;
  try {
    const students = await pool.query('SELECT id FROM students WHERE ring = $1', [ring]);
    for (let s of students.rows) {
      await pool.query(`
        INSERT INTO attendance (student_id, day_name, status, reason)
        VALUES ($1, $2, 'present', '')
        ON CONFLICT (student_id, day_name) DO UPDATE SET status = 'present';
      `, [s.id, day]);
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

// جلب إحصائيات الطالب
app.get('/api/students/:id/stats', async (req, res) => {
  const studentId = req.params.id;
  try {
    const statsQuery = `
      SELECT 
        COUNT(CASE WHEN status = 'absent' THEN 1 END) as absent_count,
        COUNT(CASE WHEN status = 'excused' THEN 1 END) as excused_count
      FROM attendance
      WHERE student_id = $1;
    `;
    const result = await pool.query(statsQuery, [studentId]);
    res.json(result.rows[0]);
  } catch (err) { 
    console.error(err);
    res.status(500).send(err.message); 
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));