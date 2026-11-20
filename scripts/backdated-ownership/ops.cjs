// Explicit isolated-test helpers. No working database defaults or production Docker names.
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const docker=process.env.DOCKER_EXE||'docker';
const run=(args,input)=>execFileSync(docker,args,{input,encoding:'utf8',windowsHide:true,maxBuffer:80*1024*1024}).trim();
const sql=(container,db,q)=>run(['exec','-i',container,'psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],q);


function snapshot(pg,db){const tables=sql(pg,db,"select tablename from pg_tables where schemaname='public' order by tablename").split('\n');return JSON.parse(sql(pg,db,'select jsonb_object_agg(k,v) from ('+tables.map(t=>`select '${t}' k,(select count(*)||':'||md5(coalesce(string_agg(to_jsonb(t)::text,chr(10) order by to_jsonb(t)::text),'')) from "${t}" t) v`).join(' union all ')+') x'));}
async function health(port){for(let n=0;n<90;n++){try{if((await fetch(`http://127.0.0.1:${port}/actuator/health`)).ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}throw Error('Unhealthy '+port);}
module.exports={run,sql,fs,docker,snapshot,health};
