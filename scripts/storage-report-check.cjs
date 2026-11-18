// Read-only comparison and benchmark. Requires a separate V53 copy of the populated chain benchmark.
// Run before with the previous backend, then after with the new backend on the SAME DB and port.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const mode=process.argv[2];assert.ok(['before','after'].includes(mode));
const db='billing_storage_report_test',name='billing-next-storage-report-test',port='8213',docker=process.env.DOCKER_EXE||'docker';
const root=path.join(__dirname,'..'),dir=path.join(root,'backups');fs.mkdirSync(dir,{recursive:true});
const run=(args,input)=>execFileSync(docker,args,{input,encoding:'utf8',windowsHide:true,maxBuffer:128*1024*1024}).trim();
const sql=q=>run(['exec','-i','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],q);
const json=q=>JSON.parse(sql(q));
assert.equal(sql('select current_database()'),db);
assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'53');
const info=JSON.parse(run(['inspect',name]))[0];assert.ok(info.Config.Env.includes('DB_NAME='+db));
assert.ok(info.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort===port));
assert.ok(Number(sql("select count(*) from container where code like 'VIEU%'"))>=10000);
const base='http://127.0.0.1:'+port+'/api/container-storage-periods';
const fields=['id','containerId','containerName','ownerName','arrivalAt','departureAt','status','startOrderId','startOrderType','startOrderNumber','endOrderId','endOrderType','endOrderNumber'];
const project=r=>Object.fromEntries(fields.map(k=>[k,r[k]??null]));
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function get(p){const r=await fetch(base+p);assert.equal(r.status,200,p);return r;}
async function page(p){return (await get(p)).json();}
const stats=a=>{a.sort((a,b)=>a-b);return {medianMs:a[2],minMs:a[0],maxMs:a[4]};};
function fingerprint(){
 const tables=json("select json_agg(tablename order by tablename) from pg_tables where schemaname='public'");
 const queries=tables.map(t=>`select '${t}' name,md5(coalesce(string_agg(row_to_json(t)::text,E'\\n' order by row_to_json(t)::text),'')) hash from "${t}" t`).join(' union all ');
 return json('select json_agg(t order by name) from ('+queries+')t');
}
function csvParse(s){const rows=[];let row=[],cell='',quoted=false;s=s.replace(/^\uFEFF/,'');for(let i=0;i<s.length;i++){const c=s[i];if(c==='"'){if(quoted&&s[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===';'&&!quoted){row.push(cell);cell='';}else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=c;}assert.equal(quoted,false);return rows;}
const date=s=>s?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(s)).replace(',',''):'';
const label=s=>({RECEIVING_ORDER:'Поставка',SHIPPING_ORDER:'Вывоз',SERVICE_ORDER:'Смена собственника'}[s]||'');
const day=s=>Math.floor((Date.parse(s)+3*3600000)/86400000);
const days=(r,asOf)=>Math.max(0,Math.min(r.departureAt?day(r.departureAt)-(r.endOrderType==='SERVICE_ORDER'?1:0):Infinity,day(asOf+'T00:00:00+03:00'))-day(r.arrivalAt)+1);
(async()=>{
 const beforeFile=path.join(dir,'storage-report-before.json'),baseline=mode==='after'?JSON.parse(fs.readFileSync(beforeFile)):null;
 const hashes=fingerprint();if(baseline)assert.deepEqual(hashes,baseline.hashes,'Same database contents required');
 const asOf=sql('select billing_today()');assert.match(asOf,/^\d{4}-\d{2}-\d{2}$/);
 const result={mode,schema:53,asOf,hashes,api:{},sql:{},warmups:3,measurements:5};
 // Compare every retained field from every page, including UUIDs and source document numbers.
 const first=await page('?size=100'),rows=first.items.map(project);
 for(let p=1;p<first.totalPages;p++)rows.push(...(await page('?size=100&page='+p)).items.map(project));
 assert.equal(rows.length,first.totalElements);result.rows=rows;result.periods=rows.length;result.reportHash=digest(rows);
 if(baseline)assert.deepEqual(rows,baseline.rows,'New report must equal the retained fields of the previous report');
 const coverage={};for(const r of rows){const key=[r.status,r.startOrderType,r.endOrderType].join('/');coverage[key]=(coverage[key]||0)+1;}
 assert.ok(rows.some(r=>r.startOrderType==='SERVICE_ORDER'));assert.ok(rows.some(r=>r.endOrderType==='SERVICE_ORDER'));
 assert.ok(rows.some(r=>r.endOrderType==='SHIPPING_ORDER'));assert.ok(rows.some(r=>r.status==='OPEN'));
 result.coverage=coverage;
 for(const r of rows.filter(r=>r.status==='OPEN'))for(const k of ['departureAt','endOrderId','endOrderType','endOrderNumber'])assert.equal(r[k],null);
 result.filters={};
 const client=sql('select client_id from receiving_order order by id limit 1');
 for(const [key,query]of Object.entries({open:'status=OPEN',closed:'status=CLOSED',cancelled:'status=CANCELLED',missing:'query=NO-SUCH-CONTAINER',container:'query=VIEU0000051',client:'clientId='+client,dates:'arrivalFrom=2025-03-01&arrivalTo=2025-04-01',past:'asOf=2025-06-01',period:'periodId='+rows[0].id})){
  const p=await page('?size=100&'+query);result.filters[key]={total:p.totalElements,items:p.items.map(project)};
 }
 assert.equal(result.filters.cancelled.total,0);assert.equal(result.filters.missing.total,0);
 if(baseline)assert.deepEqual(result.filters,baseline.filters);
 const cancelled=sql("select id from container_storage_period where status='CANCELLED' order by id limit 1");
 assert.ok(cancelled);assert.equal((await page('?status=ALL&periodId='+cancelled)).totalElements,0);
 for(const query of ['status=INVALID','arrivalFrom=2026-02-01&arrivalTo=2026-01-01','asOf=9999-12-31'])assert.equal((await fetch(base+'?'+query)).status,400);
 const csv=await (await get('/export')).text(),parsed=csvParse(csv);assert.equal(parsed.length,rows.length+1);
 if(mode==='after'){
  assert.deepEqual(parsed[0],['Номер КТК','Собственник КТК','Начало периода','Тип начала','Номер заявки начала','Окончание периода','Тип окончания','Номер заявки окончания','Дней хранения','Статус хранения']);
  assert.deepEqual(parsed.slice(1),rows.map(r=>[r.containerName,r.ownerName||'',date(r.arrivalAt),label(r.startOrderType),String(r.startOrderNumber??''),date(r.departureAt),label(r.endOrderType),String(r.endOrderNumber??''),String(days(r,asOf)),r.status==='OPEN'?'Открыт':'Закрыт']));
 }
 for(const [key,p]of Object.entries({page20:'?size=20',deepPage:'?size=20&page=250',filtered:'?size=20&query=VIEU0000051',export:'/export'})){
  for(let i=0;i<3;i++)await (await get(p)).arrayBuffer();
  const times=[];let bytes=0;for(let i=0;i<5;i++){const start=performance.now();const body=await (await get(p)).arrayBuffer();times.push(performance.now()-start);bytes=body.byteLength;}
  result.api[key]={...stats(times),bytes};console.log('API',key,result.api[key]);
 }
 let select,from,where,order;
 if(mode==='before'){
  select=`select p.*,greatest(0,(least(coalesce((p.shipping_at at time zone 'Europe/Moscow')::date-case when p.departure_operation_type='OWNER_CHANGE' then 1 else 0 end,DATE '${asOf}'),DATE '${asOf}')-(p.receiving_at at time zone 'Europe/Moscow')::date)+1)::bigint storage_days from container_storage_period_view p`;
  from='from container_storage_period_view p';where=` where p.status<>'CANCELLED' and (p.receiving_at at time zone 'Europe/Moscow')::date<=DATE '${asOf}'`;order='p.receiving_at desc,p.id';
 }else{
  const source=fs.readFileSync(path.join(root,'backend/src/main/java/ru/billing/app/containerstock/ContainerStorageController.java'),'utf8');
  from=source.match(/String FROM="""([\s\S]*?)""";/)[1];
  const parts=source.match(/String SELECT="""([\s\S]*?)"""\+FROM\+"""([\s\S]*?)""";/);select=parts[1]+from+parts[2];
  where=` where p.status in ('OPEN','CLOSED') and (h.occurred_at at time zone 'Europe/Moscow')::date<=DATE '${asOf}'`;order='h.occurred_at desc,p.id';
 }
 for(const [key,q]of Object.entries({page20:select+where+' order by '+order+' limit 20',count:'select count(*) '+from+where,deepPage:select+where+' order by '+order+' limit 20 offset 5000',export:select+where+' order by '+order})){
  for(let i=0;i<3;i++)json('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+q);
  const plans=Array.from({length:5},()=>json('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+q)[0]);
  result.sql[key]=stats(plans.map(p=>p['Execution Time']));
  fs.writeFileSync(path.join(dir,`storage-report-${mode}-plan-${key}.json`),JSON.stringify(plans.at(-1),null,2));
  console.log('SQL',key,result.sql[key]);
 }
 assert.deepEqual(fingerprint(),hashes,'Read-only checks must preserve all tables');
 fs.writeFileSync(path.join(dir,'storage-report-'+mode+'.json'),JSON.stringify(result,null,2));
 console.log('PASS',mode,rows.length,'periods; all tables unchanged;',coverage);
})().catch(e=>{console.error(e);process.exitCode=1});
