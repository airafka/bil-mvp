// Explicit isolated-test helpers. No working database defaults or production Docker names.
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const docker=process.env.DOCKER_EXE||'docker';
const run=(args,input)=>execFileSync(docker,args,{input,encoding:'utf8',windowsHide:true,maxBuffer:80*1024*1024}).trim();
const sql=(container,db,q)=>run(['exec','-i',container,'psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],q);
module.exports={run,sql,fs,docker};
