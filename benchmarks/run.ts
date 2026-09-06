import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedInteger, pool, summary } from './stats.js';

// Deliberately not configurable: this runner must never target a public deployment.
const base = 'http://127.0.0.1:3011';
const rateBase = 'http://127.0.0.1:3012';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const count = boundedInteger(process.env.BENCHMARK_EVENTS, 500, 20, 2000);
const concurrency = boundedInteger(process.env.BENCHMARK_CONCURRENCY, 10, 1, 50);
const repeats = boundedInteger(process.env.BENCHMARK_REPEATS, 3, 1, 5);
const timeoutMs = boundedInteger(process.env.BENCHMARK_DRAIN_SECONDS, 180, 10, 600) * 1000;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(root, 'benchmarks', 'results', stamp);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Job = { _id: string; status: string; attempts: number; runAttempts: number; generation: number;
  durationMs?: number; latencyMs?: number; deadPending?: boolean };
type Sample = { status: number; elapsedMs: number; data: Record<string, any> };
type Scope = { projectId: string; key: string };
const report: Record<string, any> = {
  schemaVersion: 1, startedAt: new Date().toISOString(), outcome: 'incomplete',
  methodology: 'Local real HTTP, MongoDB, Redis and BullMQ; closed-loop fixed concurrency; reference handler; no external webhooks or AI.',
  config: { count, concurrency, repeats, warmupEvents:20, drainTimeoutMs:timeoutMs,
    requestRateLimit:100000, projectRateLimit:100000, rateProbeProjectLimit:2,
    workerConcurrency:5, retryDelayMs:1000, requestTimeoutMs:15000,
    dispatchIntervalMs:1000, pollIntervalMs:1000, payloadPaddingBytes:256 },
  machine: { platform:os.platform(), arch:os.arch(), node:process.version,
    cpu:os.cpus()[0]?.model, logicalCPUs:os.cpus().length, hostMemoryBytes:os.totalmem() },
  checks: [], rounds: [],
};
function capture(command: string, args: string[]) {
  try { return execFileSync(command, args, {cwd:root, encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}).trim(); }
  catch { return 'unavailable'; }
}
function check(name: string, passed: boolean, details: unknown = null) {
  report.checks.push({name, passed, details});
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
}
async function request(url: string, method='GET', body?: unknown, headers: Record<string,string> = {}): Promise<Sample> {
  const start = performance.now();
  try {
    const response = await fetch(url, { method, headers:{'content-type':'application/json',...headers},
      body:body===undefined?undefined:JSON.stringify(body), signal:AbortSignal.timeout(15000), redirect:'error' });
    const text = await response.text();
    let data: Record<string, any>;
    try { data=JSON.parse(text); } catch { data={}; }
    return {status:response.status,elapsedMs:performance.now()-start,data};
  } catch { return {status:0,elapsedMs:performance.now()-start,data:{}}; }
}
function expectStatus(sample: Sample, expected: number, context: string) {
  if(sample.status!==expected) throw new Error(`${context}: expected HTTP ${expected}, received ${sample.status}; inspect local container logs.`);
}
let access='';
const auth=()=>({authorization:`Bearer ${access}`});
async function scope(name: string): Promise<Scope> {
  const project=await request(`${base}/api/projects`,'POST',{name},auth());
  expectStatus(project,201,'Create benchmark project');
  const projectId=project.data.project._id;
  const key=await request(`${base}/api/projects/${projectId}/keys`,'POST',{name:'benchmark'},auth());
  expectStatus(key,201,'Create benchmark key');
  return {projectId,key:key.data.secret};
}
async function send(s: Scope, i: number, payload: object={sequence:i,padding:'x'.repeat(256)}, idem=`event-${i}`, host=base) {
  return request(`${host}/events`,'POST',{name:'benchmark.event',payload,priority:5},
    {'x-api-key':s.key,'idempotency-key':idem});
}
async function jobs(s: Scope) {
  const all: Job[]=[];
  for(let page=1;page<=100;page++) {
    const response=await request(`${base}/api/projects/${s.projectId}/jobs?page=${page}`,'GET',undefined,auth());
    expectStatus(response,200,'Read benchmark jobs');
    all.push(...response.data.jobs);
    if(all.length>=response.data.total)return all;
  }
  throw new Error('Benchmark pagination bound exceeded');
}
async function drain(s: Scope, expected: number, requireArchived=false) {
  const deadline=performance.now()+timeoutMs;
  let latest: Job[]=[];
  do {
    latest=await jobs(s);
    if(latest.length===expected && latest.every(j=>j.status==='succeeded'||(j.status==='dead-letter'&&(!requireArchived||j.deadPending===false))))
      return {complete:true,jobs:latest};
    await sleep(1000);
  } while(performance.now()<deadline);
  return {complete:false,jobs:latest};
}
async function successRound(label:string,n:number,record:boolean) {
  const s=await scope(label);
  const start=performance.now();
  const samples=await pool(n,concurrency,i=>send(s,i));
  const ingestSeconds=(performance.now()-start)/1000;
  const accepted=samples.filter(r=>r.status===202);
  const ids=new Set(accepted.map(r=>r.data.eventId));
  const finished=await drain(s,accepted.length);
  const observedSeconds=(performance.now()-start)/1000;
  const succeeded=finished.jobs.filter(j=>j.status==='succeeded');
  const durations=succeeded.flatMap(j=>typeof j.durationMs==='number'?[j.durationMs]:[]);
  const latencies=succeeded.flatMap(j=>typeof j.latencyMs==='number'?[j.latencyMs]:[]);
  const statuses: Record<string,number>={};
  for(const sample of samples)statuses[String(sample.status)]=(statuses[String(sample.status)]||0)+1;
  const passed=accepted.length===n && ids.size===n && finished.complete && succeeded.length===n && durations.length===n && latencies.length===n;
  check(label,passed,{sent:n,accepted:accepted.length,succeeded:succeeded.length,drained:finished.complete});
  if(record) report.rounds.push({label,passed,requests:n,statuses,accepted:accepted.length,
    succeeded:succeeded.length,uniqueAcceptedIds:ids.size,drained:finished.complete,
    ingestSeconds,observedCompletionSeconds:observedSeconds,
    acceptedRequestsPerSecond:accepted.length/ingestSeconds,
    observedCompletionsPerSecond:succeeded.length/observedSeconds,
    allHttpMs:summary(samples.map(s=>s.elapsedMs)),acceptedHttpMs:summary(accepted.map(s=>s.elapsedMs)),
    processingMs:summary(durations),endToEndMs:summary(latencies),
    // Retain raw numeric samples for re-analysis, but no tokens, keys, cookies or payloads.
    raw:{http:samples.map(({status,elapsedMs})=>({status,elapsedMs})),processingMs:durations,endToEndMs:latencies}});
  if(!passed) throw new Error(`${label} failed; partial measurements retained, not eligible for throughput claims.`);
}
async function reliability() {
  const duplicateScope=await scope('Duplicate requests');
  const duplicates=await pool(20,10,()=>send(duplicateScope,0,{order:1},'shared'));
  const stored=await jobs(duplicateScope);
  check('20 concurrent identical requests create one event',
    duplicates.filter(r=>r.status===202).length===1 && duplicates.filter(r=>r.status===200).length===19 &&
    new Set(duplicates.map(r=>r.data.eventId)).size===1 && stored.length===1);
  check('Reused key with changed payload returns 409',(await send(duplicateScope,0,{order:2},'shared')).status===409);
  const retryScope=await scope('Retry and dead-letter fixtures');
  const fixtures=await pool(10,5,i=>send(retryScope,i,i<5?{failUntilAttempt:1}:{simulateFailure:true}));
  const finished=await drain(retryScope,10,true);
  const transient=finished.jobs.filter(j=>j.status==='succeeded'&&j.attempts===2);
  const dead=finished.jobs.filter(j=>j.status==='dead-letter'&&j.attempts===3&&j.deadPending===false);
  check('5 transient failures succeed on attempt 2',fixtures.every(r=>r.status===202)&&finished.complete&&transient.length===5);
  check('5 permanent failures exhaust 3 attempts and complete archival',finished.complete&&dead.length===5);
  if(dead.length) {
    const retry=await request(`${base}/api/projects/${retryScope.projectId}/jobs/${dead[0]._id}/retry`,'POST',{},auth());
    const retried=await drain(retryScope,10,true);
    const record=retried.jobs.find(j=>j._id===dead[0]._id);
    check('Manual retry creates generation 1 and preserves cumulative attempts',retry.status===200&&record?.generation===1&&record.attempts===6&&record.status==='dead-letter');
  } else check('Manual retry creates generation 1 and preserves cumulative attempts',false,'No archived fixture');
  const limited=await scope('Rate limit across keys');
  const second=await request(`${base}/api/projects/${limited.projectId}/keys`,'POST',{name:'second'},auth());
  expectStatus(second,201,'Create second rate-probe key');
  const a=await send(limited,0,{},'rate-0',rateBase);
  const b=await send({...limited,key:second.data.secret},1,{},'rate-1',rateBase);
  const c=await send(limited,2,{},'rate-2',rateBase);
  check('Project quota is shared across two API keys',a.status===202&&b.status===202&&c.status===429&&c.data.error==='Project rate limit exceeded; retry in one minute',
    {configuredLimit:2,statuses:[a.status,b.status,c.status]});
  check('Ingestion without API key returns 401',(await request(`${base}/events`,'POST',{name:'benchmark.event'})).status===401);
  const other=await request(`${base}/api/auth/register`,'POST',{
    email:`other-${stamp}@benchmark.invalid`,password:randomBytes(24).toString('hex')});
  expectStatus(other,201,'Register isolation fixture');
  const denied=await request(`${base}/api/projects/${duplicateScope.projectId}/jobs`,'GET',undefined,{authorization:`Bearer ${other.data.accessToken}`});
  check('Another account cannot inspect benchmark project',denied.status===404);
}

function markdown() {
  const f=(n:number|null|undefined)=>typeof n==='number'?n.toFixed(2):'—';
  return `# EventForge local benchmark — ${report.startedAt}\n\n`+
    `Outcome: **${report.outcome}**. Only passing runs are eligible for performance claims.\n\n`+
    `Real HTTP against isolated Docker services; reference handler; ${count} unique events per measured round, ${repeats} rounds, client concurrency ${concurrency}, worker concurrency 5. One 20-event warm-up is excluded.\n\n`+
    `## Environment\n\n- Commit: ${report.commit}\n- Dirty working tree: ${report.dirty}\n- Source/config SHA-256: ${report.sourceHash}\n- Host: ${report.machine.platform}/${report.machine.arch}; ${report.machine.cpu}; ${report.machine.logicalCPUs} logical CPUs; ${(report.machine.hostMemoryBytes/1024**3).toFixed(1)} GiB RAM\n- Load generator: ${process.version}\n- Docker allocation and image identifiers: see report.json.\n\n`+
    `## Measured rounds\n\n| Round | Accepted / sent | Succeeded | Accepted req/s | Observed completions/s | HTTP p95 ms (202 only) | E2E p95 ms | E2E p99 ms | Processing p95 ms |\n|---|---|---|---|---|---|---|---|---|\n`+
    report.rounds.map((r:any)=>`| ${r.label} | ${r.accepted}/${r.requests} | ${r.succeeded} | ${f(r.acceptedRequestsPerSecond)} | ${f(r.observedCompletionsPerSecond)} | ${f(r.acceptedHttpMs.p95)} | ${f(r.endToEndMs.p95)} | ${f(r.endToEndMs.p99)} | ${f(r.processingMs.p95)} |`).join('\n')+
    `\n\nHTTP latency measures request start through response body receipt. End-to-end latency comes from stored event timestamps; processing timing is the app's successful-attempt timer. Observed completion rate includes drain polling and is not steady-state maximum worker throughput. Nearest-rank percentiles; raw samples and status counts are in report.json.\n\n`+
    `## Correctness probes\n\n`+report.checks.map((c:any)=>`- ${c.passed?'PASS':'FAIL'}: ${c.name}`).join('\n')+
    `\n\n## Limitations\n\nClosed-loop clients slow down when responses slow down (coordinated omission); this is not an arrival-rate stress test. Raised benchmark-only limits (100,000/minute) differ from production defaults. A separate API applies a 2/minute project limit to verify throttling. Logs remain enabled. The load generator and services share a host; Docker CPU/memory allocation, warm caches, polling, networking and background host load affect results. No external webhook delivery, AI, uptime, multi-region, production capacity or exactly-once guarantee is measured. HTTP errors (including timeouts as status 0) and incomplete drains invalidate a round. No retries of load-generator requests.\n\n`+
    (report.failure?`Failure: ${report.failure}\n\n`:'')+
    `Do not describe a local result as hosted throughput. Compare multiple passing runs under the same recorded environment; do not select only the fastest run.\n`;
}

try {
  report.commit=capture('git',['rev-parse','HEAD']);
  report.dirty=capture('git',['status','--porcelain']).length>0;
  report.docker=capture('docker',['info','--format','{{json .ServerVersion}} CPUs={{.NCPU}} MemoryBytes={{.MemTotal}}']);
  report.images=capture('docker',['compose','-f','compose.benchmark.yaml','images','--format','json']);
  const hash=createHash('sha256');
  for(const file of ['server/app.ts','server/worker.ts','server/processing.ts','server/redis.ts','server/core.ts','server/db.ts','server/index.ts','server/webhooks.ts','package.json','package-lock.json','Dockerfile','compose.benchmark.yaml','benchmarks/run.ts','benchmarks/stats.ts']) {
    hash.update(file);hash.update(await readFile(path.join(root,file)));
  }
  report.sourceHash=hash.digest('hex');
  console.log('Local-only benchmark: ports 3011/3012. Creates disposable accounts/projects; never reads .env.');
  for(const host of [base,rateBase]) {
    const health=await request(`${host}/api/health`);
    expectStatus(health,200,'Isolated stack health');
    if(health.data.ok!==true)throw new Error('Isolated stack is not ready');
  }
  const registered=await request(`${base}/api/auth/register`,'POST',{
    email:`load-${stamp}@benchmark.invalid`,password:randomBytes(24).toString('hex')});
  expectStatus(registered,201,'Register load fixture');access=registered.data.accessToken;
  await successRound('Warm-up',20,false);
  for(let round=1;round<=repeats;round++)await successRound(`Round ${round}`,count,true);
  await reliability();
  report.outcome=report.checks.every((c:any)=>c.passed)?'passed':'failed';
} catch(error) {
  report.outcome='failed';report.failure=error instanceof Error?error.message:'Unknown benchmark failure';
  console.error(report.failure);
} finally {
  report.finishedAt=new Date().toISOString();
  await mkdir(output,{recursive:true});
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(path.join(output,'report.md'),markdown());
  console.log(`Reports: ${output}`);
  if(report.outcome!=='passed')process.exitCode=1;
}
