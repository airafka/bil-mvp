// Read-only fingerprint of working billing-next data before/after deployment.
const fs=require('fs'),assert=require('node:assert/strict'),{execFileSync}=require('child_process');
const stage=process.argv[2];assert.ok(['before','after'].includes(stage));
const docker='C:/Users/Green-0482/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';
const sql=q=>execFileSync(docker,['exec','billing-next-db-1','psql','-U','billing','-d','billing_next','-At','-v','ON_ERROR_STOP=1','-c',q],{windowsHide:true,encoding:'utf8'}).trim();
const tables=sql("select tablename from pg_tables where schemaname='public' order by tablename").split('\n');
const fingerprints={};for(const table of tables){assert.match(table,/^[a-z_0-9]+$/);fingerprints[table]=JSON.parse(sql('select json_build_object(\'rows\',count(*),\'checksum\',md5(coalesce(string_agg(row_to_json(t)::text,\'\' order by row_to_json(t)::text),\'\'))) from "'+table+'" t'));}
fingerprints.sequences=JSON.parse(sql("select coalesce(json_agg(t order by sequencename),'[]') from (select sequencename,last_value from pg_sequences where schemaname='public')t"));
fs.writeFileSync('database/return-progress-20261109-live-'+stage+'.json',JSON.stringify(fingerprints,null,2));
if(stage==='after')assert.deepEqual(fingerprints,JSON.parse(fs.readFileSync('database/return-progress-20261109-live-before.json','utf8')));
console.log('PASS working data',stage,tables.length,'tables and sequences');
