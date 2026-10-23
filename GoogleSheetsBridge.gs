/** Google Apps Script bridge. D1 remains the source of truth; this script only upserts report rows. */
const SPREADSHEET_ID = 'PASTE_GOOGLE_SPREADSHEET_ID_HERE';
const SHEET_NAME = 'Attendance';
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const expected = PropertiesService.getScriptProperties().getProperty('D1_SYNC_SECRET');
    if (!expected || !body.secret || !constantTimeEqual_(String(body.secret), expected)) return output_({ok:false,error:'UNAUTHORIZED'});
    if (!Array.isArray(body.rows) || body.rows.length > 20000) return output_({ok:false,error:'INVALID_ROWS'});
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let sh = ss.getSheetByName(SHEET_NAME); if (!sh) sh = ss.insertSheet(SHEET_NAME);
    const headers = ['RecordID','EmployeeID','DisplayName','WorkDate','ClockIn','ClockOut','BreakMinutes','WorkMinutes','WorkHours','Status','CreatedAt','UpdatedAt'];
    if (sh.getLastRow() === 0) sh.appendRow(headers); else {
      const current = sh.getRange(1,1,1,headers.length).getDisplayValues()[0];
      if (current.join('|') !== headers.join('|')) return output_({ok:false,error:'HEADER_MISMATCH'});
    }
    // Upsert by RecordID so retrying the same date range doesn't duplicate rows.
    const last = sh.getLastRow(); const ids = last > 1 ? sh.getRange(2,1,last-1,1).getDisplayValues().flat() : [];
    const rowById = new Map(ids.map((id,i)=>[id,i+2]));
    const append = [], updates = [];
    body.rows.forEach(r => {
      const values = [r.record_id,r.employee_id,r.display_name,r.work_date,r.clock_in,r.clock_out,r.break_minutes,r.work_minutes,r.work_hours,r.status,r.created_at,r.updated_at].map(safeCell_);
      const rowNo = rowById.get(String(r.record_id)); if (rowNo) updates.push([rowNo,values]); else append.push(values);
    });
    updates.forEach(([rowNo,values])=>sh.getRange(rowNo,1,1,headers.length).setValues([values]));
    if (append.length) sh.getRange(sh.getLastRow()+1,1,append.length,headers.length).setValues(append);
    return output_({ok:true,syncId:body.syncId,received:body.rows.length,inserted:append.length,updated:updates.length});
  } catch (err) { return output_({ok:false,error:'SYNC_ERROR',message:String(err && err.message || err)}); }
}
function safeCell_(v) { if (v === null || v === undefined) return ''; const s=String(v); return /^[\s\u0000-\u001f]*[=+\-@]/.test(s) ? "'"+s : v; }
function constantTimeEqual_(a,b) { if (a.length !== b.length) return false; let x=0; for(let i=0;i<a.length;i++) x |= a.charCodeAt(i)^b.charCodeAt(i); return x===0; }
function output_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
