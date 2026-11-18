// Read-only API/CSV comparison with an independent SQL day calculation on the isolated V53 report fixture.
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',db='billing_storage_report_test',base='http://127.0.0.1:8213/api/container-storage-periods';
const run=args=>execFileSync(docker,args,{encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024}).trim();
const sql=q=>run(['exec','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',q]);
assert.equal(sql('select current_database()'),db);
const info=JSON.parse(run(['inspect','billing-next-storage-report-test']))[0];
assert.ok(info.Config.Env.includes('DB_NAME='+db));assert.ok(info.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8213'));
async function get(p){const r=await fetch(base+p);assert.equal(r.status,200,p);return r;}
function csvParse(s){const rows=[];let row=[],cell='',quoted=false;s=s.replace(/^\uFEFF/,'');for(let i=0;i<s.length;i++){const c=s[i];if(c==='"'){if(quoted&&s[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===';'&&!quoted){row.push(cell);cell='';}else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=c;}assert.equal(quoted,false);return rows;}
(async()=>{
 const today=sql('select billing_today()');assert.match(today,/^\d{4}-\d{2}-\d{2}$/);
 for(const asOf of [today,'2026-09-17','2025-06-01']){
  assert.ok(asOf<=today);
  const expected=JSON.parse(sql(`select coalesce(json_agg(t order by t.started desc,t.id),'[]') from (
   select p.id,c.code,h.occurred_at started,
    greatest(0,least(coalesce((e.occurred_at at time zone 'Europe/Moscow')::date
      -case when e.order_type='SERVICE_ORDER' then 1 else 0 end,date '${asOf}'),date '${asOf}')
      -(h.occurred_at at time zone 'Europe/Moscow')::date+1) days
   from container_storage_period p join container_owner_history h on h.id=p.start_history_id
   left join container_owner_history e on e.id=p.end_history_id join container c on c.id=p.container_id
   where p.status in ('OPEN','CLOSED') and (h.occurred_at at time zone 'Europe/Moscow')::date<=date '${asOf}')t`));
  const suffix='&asOf='+asOf,first=await (await get('?size=100'+suffix)).json(),rows=[...first.items];
  for(let p=1;p<first.totalPages;p++)rows.push(...(await (await get('?size=100&page='+p+suffix)).json()).items);
  assert.equal(rows.length,expected.length);assert.equal(first.totalElements,expected.length);
  assert.deepEqual(rows.map(r=>[r.id,r.containerName,r.storageDays]),expected.map(r=>[r.id,r.code,r.days]));
  const csv=csvParse(await (await get('/export?asOf='+asOf)).text());
  assert.equal(csv[0].length,10);assert.equal(csv[0][8],'Дней хранения');assert.equal(csv.length,rows.length+1);
  assert.deepEqual(csv.slice(1).map(r=>[r[0],Number(r[8])]),expected.map(r=>[r.code,r.days]));
  assert.ok(rows.every(r=>Number.isInteger(r.storageDays)&&r.storageDays>=0));
  if(asOf===today){assert.ok(rows.some(r=>r.storageDays===0));assert.ok(rows.some(r=>r.status==='OPEN'));}
  console.log('PASS:',asOf,rows.length,'periods, API and CSV agree with start/end history dates');
 }
})().catch(e=>{console.error(e);process.exitCode=1});
