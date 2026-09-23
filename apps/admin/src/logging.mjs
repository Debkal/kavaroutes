const statuses=Object.freeze({
  ADMIN_READY:'KavaRoutes admin service ready',
  ADMIN_EMAIL_WORKER_FAILED:'ADMIN_EMAIL_WORKER_FAILED',
});

export function adminStatus(code){
  const message=statuses[code];
  if(!message)throw new Error('ADMIN_STATUS_INVALID');
  const stream=code==='ADMIN_EMAIL_WORKER_FAILED'?process.stderr:process.stdout;
  stream.write(`${message}\n`);
}
