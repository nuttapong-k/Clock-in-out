import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const [employeeId, displayName, password] = process.argv.slice(2);
if (!employeeId || !displayName || !password || password.length < 12) {
  console.error('Usage: node scripts/create-admin.mjs ADMIN001 "System Admin" "Long-Unique-Password-12+"'); process.exit(1);
}
const salt = randomBytes(16).toString('hex');
const hash = pbkdf2Sync(password, Buffer.from(salt,'hex'), 310000, 32, 'sha256').toString('hex');
const q = v => "'" + String(v).replace(/'/g,"''") + "'";
const now = new Date().toISOString();
const sql = `INSERT INTO employees(employee_id,display_name,role,active,password_salt,password_hash,password_algorithm,password_iterations,created_at,updated_at) VALUES(${q(employeeId.trim().toUpperCase())},${q(displayName.trim())},'admin',1,${q(salt)},${q(hash)},'PBKDF2-SHA256',310000,${q(now)},${q(now)});\n`;
writeFileSync('seed-admin.sql', sql, {mode:0o600});
console.log('Created seed-admin.sql. Apply it to D1, then securely delete the SQL file and do not share the password.');
