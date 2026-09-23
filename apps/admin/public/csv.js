// Adapted from apps/web/src/csv.ts: one escaping boundary for every spreadsheet cell.
export function csvCell(value){const raw=value==null?'':String(value);const safe=typeof value==='string'&&(/^[\s\uFEFF]*[=+\-@]/.test(raw)||/^[\t\r\n]/.test(raw))?`'${raw}`:raw;return `"${safe.replaceAll('"','""')}"`;}
export function csvBody(rows){return '\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');}
export function downloadCsv(filename,rows){const url=URL.createObjectURL(new Blob([csvBody(rows)],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
