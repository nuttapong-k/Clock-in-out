const SESSION_DAYS = 1;
const PBKDF2_ITERATIONS = 310000;
const MAX_SYNC_DAYS = 31;
const MAX_SYNC_ROWS = 20000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', {status:404});
    if (request.method === 'OPTIONS') return new Response(null, {status:204, headers:corsHeaders(request, env)});
    try {
      if (url.pathname === '/api/health' && request.method === 'GET') return json({ok:true,service:'clockinout-d1'},200,request,env);
      if (url.pathname === '/api/login' && request.method === 'POST') return login(request,env);
      if (url.pathname === '/api/logout' && request.method === 'POST') { const u=await requireUser(request,env); await env.DB.prepare('DELETE FROM sessions WHERE employee_id=?').bind(u.employee_id).run(); return json({ok:true},200,request,env); }
      if (url.pathname === '/api/me' && request.method === 'GET') { const u=await requireUser(request,env); return json({ok:true,user:{employeeId:u.employee_id,displayName:u.display_name,role:u.role}},200,request,env); }
      if (url.pathname === '/api/clock/in' && request.method === 'POST') return clockIn(request,env);
      if (url.pathname === '/api/clock/out' && request.method === 'POST') return clockOut(request,env);
      if (url.pathname === '/api/history' && request.method === 'GET') return history(request,env);
      if (url.pathname === '/api/admin/employees' && request.method === 'GET') return listEmployees(request,env);
      if (url.pathname === '/api/admin/employees' && request.method === 'POST') return createEmployee(request,env);
      if (url.pathname === '/api/admin/password-reset' && request.method === 'POST') return resetPassword(request,env);
      if (url.pathname === '/api/admin/sync-sheets' && request.method === 'POST') return syncSheets(request,env);
      if (url.pathname === '/api/admin/export.csv' && request.method === 'GET') return exportCsv(request,env);
      return json({ok:false,error:'NOT_FOUND'},404,request,env);
    } catch(e) {
      if (e?.httpStatus) return json({ok:false,error:e.code||'REQUEST_FAILED'},e.httpStatus,request,env);
      console.error('Request failed', e?.message || 'unknown');
      return json({ok:false,error:'INTERNAL_ERROR'},500,request,env);
    }
  }
};

async function login(req,env){
  const b=await body(req); const id=cleanId(b.employeeId); const password=String(b.password||'');
  if(!id||!password||password.length>256) throw err(400,'INVALID_INPUT');
  const e=await env.DB.prepare('SELECT * FROM employees WHERE employee_id=? LIMIT 1').bind(id).first();
  // Keep response generic to avoid revealing whether an employee ID exists.
  if(!e||!e.active) throw err(401,'INVALID_CREDENTIALS');
  const candidate=await derive(password,e.password_salt,Number(e.password_iterations)||PBKDF2_ITERATIONS);
  if(!constantTimeEqual(candidate,e.password_hash)) throw err(401,'INVALID_CREDENTIALS');
  // Upgrade work factor on successful login when the stored setting is older.
  if(e.password_algorithm!=='PBKDF2-SHA256'||Number(e.password_iterations)<PBKDF2_ITERATIONS){
    const salt=toHex(crypto.getRandomValues(new Uint8Array(16))); const hash=await derive(password,salt,PBKDF2_ITERATIONS);
    await env.DB.prepare('UPDATE employees SET password_salt=?,password_hash=?,password_algorithm=?,password_iterations=?,updated_at=? WHERE employee_id=?').bind(salt,hash,'PBKDF2-SHA256',PBKDF2_ITERATIONS,now(),id).run();
  }
  const token=toHex(crypto.getRandomValues(new Uint8Array(32))); const tokenHash=await sha256(token); const created=now(); const expiry=new Date(Date.now()+SESSION_DAYS*86400000).toISOString();
  await env.DB.prepare('DELETE FROM sessions WHERE employee_id=? OR expires_at<=?').bind(id,created).run();
  await env.DB.prepare('INSERT INTO sessions(token_hash,employee_id,expires_at,created_at) VALUES(?,?,?,?)').bind(tokenHash,id,expiry,created).run();
  await audit(env,id,'LOGIN',id,'Login success');
  return json({ok:true,token,expiresAt:expiry,user:{employeeId:e.employee_id,displayName:e.display_name,role:e.role}},200,req,env);
}
async function clockIn(req,env){
  const u=await requireUser(req,env); const t=new Date(); const date=localDate(t,env.TIME_ZONE||'Asia/Bangkok'); const iso=t.toISOString(); const id=crypto.randomUUID();
  const r=await env.DB.prepare(`INSERT INTO attendance(record_id,employee_id,display_name,work_date,clock_in,status,created_at,updated_at) VALUES(?,?,?,?,?,'OPEN',?,?) ON CONFLICT(employee_id,work_date) DO NOTHING`).bind(id,u.employee_id,u.display_name,date,iso,iso,iso).run();
  if(!r.meta?.changes) throw err(409,'ALREADY_CLOCKED_IN_TODAY');
  await audit(env,u.employee_id,'CLOCK_IN',id,`work_date=${date}`); return json({ok:true,clockIn:iso,workDate:date},200,req,env);
}
async function clockOut(req,env){
  const u=await requireUser(req,env); const t=new Date(); const date=localDate(t,env.TIME_ZONE||'Asia/Bangkok'); const iso=t.toISOString();
  const a=await env.DB.prepare("SELECT * FROM attendance WHERE employee_id=? AND work_date=? AND status='OPEN'").bind(u.employee_id,date).first();
  if(!a) throw err(409,'NO_OPEN_SHIFT_TODAY');
  const mins=Math.max(0,Math.floor((t.getTime()-Date.parse(a.clock_in))/60000));
  await env.DB.prepare("UPDATE attendance SET clock_out=?,work_minutes=?,work_hours=?,status='CLOSED',updated_at=? WHERE record_id=? AND status='OPEN'").bind(iso,mins,Math.round(mins/60*100)/100,iso,a.record_id).run();
  await audit(env,u.employee_id,'CLOCK_OUT',a.record_id,`work_minutes=${mins}`); return json({ok:true,clockOut:iso,workMinutes:mins},200,req,env);
}
async function history(req,env){
  const u=await requireUser(req,env); const url=new URL(req.url); const from=validDate(url.searchParams.get('from'))?url.searchParams.get('from'):localDate(new Date(Date.now()-30*86400000),env.TIME_ZONE||'Asia/Bangkok'); const to=validDate(url.searchParams.get('to'))?url.searchParams.get('to'):localDate(new Date(),env.TIME_ZONE||'Asia/Bangkok');
  const rows=await env.DB.prepare('SELECT record_id,work_date,clock_in,clock_out,break_minutes,work_minutes,work_hours,status FROM attendance WHERE employee_id=? AND work_date BETWEEN ? AND ? ORDER BY work_date DESC LIMIT 400').bind(u.employee_id,from,to).all(); return json({ok:true,rows:rows.results||[]},200,req,env);
}
async function listEmployees(req,env){const u=await requireAdmin(req,env); const r=await env.DB.prepare('SELECT employee_id,display_name,role,active,created_at FROM employees ORDER BY employee_id LIMIT 2000').all(); return json({ok:true,rows:r.results||[]},200,req,env);}
async function createEmployee(req,env){const u=await requireAdmin(req,env); const b=await body(req); const id=cleanId(b.employeeId),name=String(b.displayName||'').trim(),password=String(b.password||''); const role=b.role==='admin'?'admin':'employee'; if(!id||id.length>64||!name||name.length>120||password.length<12||password.length>256) throw err(400,'INVALID_EMPLOYEE_OR_PASSWORD'); const salt=toHex(crypto.getRandomValues(new Uint8Array(16))); const hash=await derive(password,salt,PBKDF2_ITERATIONS); const n=now(); try{await env.DB.prepare('INSERT INTO employees(employee_id,display_name,role,active,password_salt,password_hash,password_algorithm,password_iterations,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,name,role,1,salt,hash,'PBKDF2-SHA256',PBKDF2_ITERATIONS,n,n).run();}catch{throw err(409,'EMPLOYEE_ID_EXISTS');} await audit(env,u.employee_id,'EMPLOYEE_CREATE',id,`role=${role}`); return json({ok:true,employeeId:id},201,req,env);}
async function resetPassword(req,env){const u=await requireAdmin(req,env);const b=await body(req);const id=cleanId(b.employeeId),password=String(b.newPassword||'');if(!id||password.length<12||password.length>256)throw err(400,'PASSWORD_MIN_12');const salt=toHex(crypto.getRandomValues(new Uint8Array(16)));const hash=await derive(password,salt,PBKDF2_ITERATIONS);const r=await env.DB.prepare('UPDATE employees SET password_salt=?,password_hash=?,password_algorithm=?,password_iterations=?,updated_at=? WHERE employee_id=?').bind(salt,hash,'PBKDF2-SHA256',PBKDF2_ITERATIONS,now(),id).run();if(!r.meta?.changes)throw err(404,'EMPLOYEE_NOT_FOUND');await env.DB.prepare('DELETE FROM sessions WHERE employee_id=?').bind(id).run();await audit(env,u.employee_id,'PASSWORD_RESET',id,'Admin reset password; sessions revoked');return json({ok:true},200,req,env);}
async function exportCsv(req,env){const u=await requireAdmin(req,env);const url=new URL(req.url);const from=url.searchParams.get('from'),to=url.searchParams.get('to');if(!validDate(from)||!validDate(to))throw err(400,'INVALID_DATE');const days=(Date.parse(to)-Date.parse(from))/86400000+1;if(days<1||days>MAX_SYNC_DAYS)throw err(400,'DATE_RANGE_LIMIT_MAX_31');const r=await env.DB.prepare('SELECT record_id,employee_id,display_name,work_date,clock_in,clock_out,break_minutes,work_minutes,work_hours,status,created_at,updated_at FROM attendance WHERE work_date BETWEEN ? AND ? ORDER BY work_date,employee_id LIMIT ?').bind(from,to,MAX_SYNC_ROWS+1).all();if((r.results||[]).length>MAX_SYNC_ROWS)throw err(413,'TOO_MANY_ROWS');const cols=['record_id','employee_id','display_name','work_date','clock_in','clock_out','break_minutes','work_minutes','work_hours','status','created_at','updated_at'];const csv='\uFEFF'+[cols.join(','),...(r.results||[]).map(x=>cols.map(k=>csvCell(x[k])).join(','))].join('\r\n')+'\r\n';await audit(env,u.employee_id,'CSV_EXPORT',null,`${from}..${to}; rows=${r.results.length}`);return new Response(csv,{headers:{...corsHeaders(req,env),'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="attendance_${from}_${to}.csv"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
async function syncSheets(req,env){const u=await requireAdmin(req,env);if(!env.GAS_WEB_APP_URL||!env.GAS_SYNC_SECRET)throw err(503,'SHEETS_SYNC_NOT_CONFIGURED');const b=await body(req);const from=b.from,to=b.to;if(!validDate(from)||!validDate(to))throw err(400,'INVALID_DATE');const days=(Date.parse(to)-Date.parse(from))/86400000+1;if(days<1||days>MAX_SYNC_DAYS)throw err(400,'DATE_RANGE_LIMIT_MAX_31');const r=await env.DB.prepare('SELECT record_id,employee_id,display_name,work_date,clock_in,clock_out,break_minutes,work_minutes,work_hours,status,created_at,updated_at FROM attendance WHERE work_date BETWEEN ? AND ? ORDER BY work_date,employee_id LIMIT ?').bind(from,to,MAX_SYNC_ROWS+1).all();const rows=r.results||[];if(rows.length>MAX_SYNC_ROWS)throw err(413,'TOO_MANY_ROWS');const syncId=crypto.randomUUID(),created=now();const payload={secret:env.GAS_SYNC_SECRET,syncId,from,to,rows};let response;try{response=await fetch(env.GAS_WEB_APP_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}catch{throw err(502,'SHEETS_UNREACHABLE');}const textBody=await response.text();let result={};try{result=JSON.parse(textBody)}catch{}const ok=response.ok&&result.ok===true;await env.DB.prepare('INSERT INTO sync_audit(sync_id,actor_id,from_date,to_date,row_count,status,created_at,message) VALUES(?,?,?,?,?,?,?,?)').bind(syncId,u.employee_id,from,to,rows.length,ok?'SUCCESS':'FAILED',created,String(result.error||result.message||response.status)).run();if(!ok)throw err(502,'SHEETS_SYNC_FAILED');await audit(env,u.employee_id,'SHEETS_SYNC',syncId,`${from}..${to}; rows=${rows.length}`);return json({ok:true,syncId,rowCount:rows.length,from,to},200,req,env);}
async function requireUser(req,env){const token=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'').trim();if(token.length<32||token.length>200)throw err(401,'UNAUTHENTICATED');const hash=await sha256(token);const row=await env.DB.prepare('SELECT e.employee_id,e.display_name,e.role,e.active,s.expires_at FROM sessions s JOIN employees e ON e.employee_id=s.employee_id WHERE s.token_hash=?').bind(hash).first();if(!row||!row.active||Date.parse(row.expires_at)<=Date.now())throw err(401,'SESSION_EXPIRED');return row;}
async function requireAdmin(req,env){const u=await requireUser(req,env);if(u.role!=='admin')throw err(403,'ADMIN_REQUIRED');return u;}
async function derive(password,saltHex,iterations){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:fromHex(saltHex),iterations},key,256);return toHex(new Uint8Array(bits));}
async function sha256(v){return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v))));}
function constantTimeEqual(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;}
function toHex(a){return [...a].map(x=>x.toString(16).padStart(2,'0')).join('');}function fromHex(s){if(!/^(?:[0-9a-f]{2})+$/i.test(s))throw err(500,'INVALID_STORED_SALT');return Uint8Array.from(s.match(/.{2}/g),x=>parseInt(x,16));}
async function body(req){try{const b=await req.json();if(!b||typeof b!=='object'||Array.isArray(b))throw 0;return b;}catch{throw err(400,'INVALID_JSON');}}
function cleanId(v){return String(v||'').trim().toUpperCase();}function now(){return new Date().toISOString();}
function localDate(d,tz){const p=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);const v={};for(const x of p)if(x.type!=='literal')v[x.type]=x.value;return `${v.year}-${v.month}-${v.day}`;}
function validDate(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(s||'')))return false;const d=new Date(`${s}T00:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;}
function csvCell(v){let s=v==null?'':String(v);if(/^[\s\u0000-\u001f]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
async function audit(env,actor,action,record,details){await env.DB.prepare('INSERT INTO audit_log(audit_id,actor_id,action,record_id,details,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),actor,action,record,details,now()).run();}
function err(httpStatus,code){const e=new Error(code);e.httpStatus=httpStatus;e.code=code;return e;}
function corsHeaders(req,env){const origin=req.headers.get('Origin');const allowed=env.ALLOWED_ORIGIN;if(origin&&allowed&&origin!==allowed)return {'Vary':'Origin'};return {'Access-Control-Allow-Origin':origin&&(!allowed||origin===allowed)?origin:(allowed||'*'),'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type','Access-Control-Max-Age':'86400','Vary':'Origin'};}
function json(data,status=200,req,env){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...corsHeaders(req,env)}});}
