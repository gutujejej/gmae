require('dotenv').config();
const bcrypt = require('bcrypt');
const { connectDatabase, query, pool } = require('../core');

async function run() {
  await connectDatabase();

  const username = process.env.SEED_ADMIN_USERNAME || 'admin';
  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';

  const existing = await query('SELECT id, username, email FROM users WHERE username = $1 OR email = $2', [
    username,
    email,
  ]);
  if (existing.rows.length > 0) {
    console.log(`Admin user already exists: ${existing.rows[0].username} <${existing.rows[0].email}>`);
    await pool.end();
    return;
  }

  const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10);
  const password_hash = await bcrypt.hash(password, saltRounds);

  const { rows } = await query(
    `INSERT INTO users (username, email, password_hash, role, balance)
     VALUES ($1, $2, $3, 'admin', 0)
     RETURNING username, email`,
    [username, email, password_hash]
  );

  console.log(`Created admin user: ${rows[0].username} <${rows[0].email}>`);
  console.log('Log in with the password set in SEED_ADMIN_PASSWORD (.env) and change it afterward if needed.');

  await pool.end();
}

run().catch((err) => {
  console.error('Failed to seed admin user:', err);
  process.exit(1);
});
