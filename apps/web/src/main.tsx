import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, Bell, Box, ChevronDown, CircleHelp, Clock3, Code2, Copy, Ellipsis, Gauge, LayoutDashboard, MoreHorizontal, Plus, RefreshCw, Search, Settings, ShieldCheck, Webhook, X } from 'lucide-react';
import './styles.css';

type Job = { id: string; event: string; status: 'Succeeded' | 'Failed' | 'Running' | 'Queued'; attempts: string; duration: string; created: string };
const jobs: Job[] = [
  { id: 'job_9f3a2c', event: 'invoice.payment_failed', status: 'Failed', attempts: '3 / 3', duration: '12.4s', created: '2m ago' },
  { id: 'job_87d1ee', event: 'user.created', status: 'Succeeded', attempts: '1 / 3', duration: '483ms', created: '4m ago' },
  { id: 'job_20b6ff', event: 'order.fulfilled', status: 'Running', attempts: '1 / 3', duration: '—', created: '5m ago' },
  { id: 'job_1c49ab', event: 'invoice.payment_succeeded', status: 'Succeeded', attempts: '1 / 3', duration: '621ms', created: '7m ago' },
  { id: 'job_6b2d91', event: 'subscription.cancelled', status: 'Queued', attempts: '0 / 3', duration: '—', created: '9m ago' },
];
const statusIcon = (status: Job['status']) => status === 'Succeeded' ? '✓' : status === 'Failed' ? '!' : status === 'Running' ? '↻' : '•';

function App() {
  const [tab, setTab] = useState('Overview'); const [modal, setModal] = useState(false); const [toast, setToast] = useState('');
  const notify = (text: string) => { setToast(text); window.setTimeout(() => setToast(''), 2600); };
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">✦</span><span>eventforge</span></div>
      <button className="project-picker"><span className="project-dot"/>Acme Commerce <ChevronDown size={15}/></button>
      <nav><p>Workspace</p>{[[LayoutDashboard,'Overview'],[Activity,'Jobs'],[Box,'Events'],[Webhook,'Webhooks'],[Gauge,'Metrics']].map(([Icon,label]) => <button key={String(label)} onClick={() => setTab(String(label))} className={tab === label ? 'nav-item active' : 'nav-item'}><Icon size={17}/>{String(label)}{label === 'Jobs' && <span className="count">3</span>}</button>)}<p className="section-gap">Developer</p>{[[Code2,'API keys'],[ShieldCheck,'Security'],[Settings,'Settings']].map(([Icon,label]) => <button key={String(label)} onClick={() => setTab(String(label))} className={tab === label ? 'nav-item active' : 'nav-item'}><Icon size={17}/>{String(label)}</button>)}</nav>
      <div className="sidebar-bottom"><button className="nav-item"><CircleHelp size={17}/>Documentation</button><div className="profile"><div className="avatar">AK</div><div><b>Abhay Kumar</b><small>abhay@acme.dev</small></div><MoreHorizontal size={17}/></div></div>
    </aside>
    <main>
      <header><div className="crumb">Acme Commerce <span>/</span> <b>{tab}</b></div><div className="header-actions"><button className="icon-button"><Search size={18}/></button><button className="icon-button"><Bell size={18}/><i/></button><button className="create" onClick={() => setModal(true)}><Plus size={16}/> Send event</button></div></header>
      <div className="content">
        <section className="hero"><div><p className="eyebrow">LAST 24 HOURS <span className="live"><i/> Live</span></p><h1>Everything is moving.</h1><p className="sub">Your event infrastructure at a glance.</p></div><button className="date"><Clock3 size={15}/> Aug 30 – Aug 31 <ChevronDown size={14}/></button></section>
        <section className="metrics">
          <Metric icon={<Activity/>} tone="violet" label="Events processed" value="48,294" trend="12.8%" detail="vs. previous period" />
          <Metric icon={<Gauge/>} tone="blue" label="Avg. processing time" value="642 ms" trend="18.2%" detail="faster than previous" />
          <Metric icon={<RefreshCw/>} tone="amber" label="Retry rate" value="1.4%" trend="0.6%" detail="of jobs retried" />
          <Metric icon={<ShieldCheck/>} tone="rose" label="Failure rate" value="0.08%" trend="0.03%" detail="within healthy range" />
        </section>
        <section className="two-col"><div className="panel chart-panel"><div className="panel-heading"><div><h2>Event throughput</h2><p>Events processed per minute</p></div><button className="select">All events <ChevronDown size={14}/></button></div><div className="chart"><div className="y-axis"><span>1.2k</span><span>800</span><span>400</span><span>0</span></div><div className="plot"><div className="grid g1"/><div className="grid g2"/><div className="grid g3"/><div className="grid g4"/><svg viewBox="0 0 650 175" preserveAspectRatio="none"><defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#7657e8" stopOpacity=".3"/><stop offset="1" stopColor="#7657e8" stopOpacity="0"/></linearGradient></defs><path d="M0 155 C30 145 38 105 63 120 S90 86 118 99 S150 128 180 95 S212 109 236 75 S274 91 300 63 S335 92 362 72 S395 83 420 49 S455 71 483 44 S515 67 548 31 S585 45 620 20 S640 25 650 9 L650 175 L0 175Z" fill="url(#fill)"/><path d="M0 155 C30 145 38 105 63 120 S90 86 118 99 S150 128 180 95 S212 109 236 75 S274 91 300 63 S335 92 362 72 S395 83 420 49 S455 71 483 44 S515 67 548 31 S585 45 620 20 S640 25 650 9" fill="none" stroke="#8b6df4" strokeWidth="3"/></svg><div className="x-axis"><span>12:00 AM</span><span>6:00 AM</span><span>12:00 PM</span><span>6:00 PM</span><span>Now</span></div></div></div></div>
        <div className="panel health"><div className="panel-heading"><div><h2>Queue health</h2><p>Real-time status across queues</p></div><button className="dots"><Ellipsis size={19}/></button></div><div className="queue-row"><div className="queue-icon purple">⌁</div><div><b>default</b><small>18,492 processed</small></div><strong>12</strong><span>waiting</span></div><div className="queue-row"><div className="queue-icon blue">⚡</div><div><b>critical</b><small>4,104 processed</small></div><strong>2</strong><span>waiting</span></div><div className="queue-row"><div className="queue-icon gold">◒</div><div><b>notifications</b><small>25,698 processed</small></div><strong>0</strong><span>waiting</span></div><button className="view-all" onClick={() => setTab('Jobs')}>View all queues <span>→</span></button></div></section>
        <section className="panel jobs"><div className="panel-heading"><div><h2>Recent jobs</h2><p>The latest activity in your project</p></div><button className="link-button" onClick={() => setTab('Jobs')}>View all jobs <span>→</span></button></div><div className="table-wrap"><table><thead><tr><th>Job</th><th>Status</th><th>Attempts</th><th>Duration</th><th>Created</th><th/></tr></thead><tbody>{jobs.map(job => <tr key={job.id}><td><div className="job"><div className="job-symbol">{job.event.startsWith('invoice') ? '$' : job.event.startsWith('user') ? '♙' : '◈'}</div><div><b>{job.event}</b><small>{job.id}</small></div></div></td><td><span className={'status '+job.status.toLowerCase()}><i>{statusIcon(job.status)}</i>{job.status}</span></td><td>{job.attempts}</td><td>{job.duration}</td><td className="muted">{job.created}</td><td><button className="dots"><Ellipsis size={18}/></button></td></tr>)}</tbody></table></div></section>
      </div>
    </main>
    {modal && <div className="modal-backdrop" onMouseDown={() => setModal(false)}><div className="modal" onMouseDown={e => e.stopPropagation()}><button className="close" onClick={() => setModal(false)}><X size={18}/></button><span className="modal-icon">✦</span><h2>Send a test event</h2><p>Publish an event to Acme Commerce’s default queue.</p><label>Event name<input defaultValue="order.fulfilled"/></label><label>Payload<textarea defaultValue={'{\n  "orderId": "ord_9281",\n  "total": 129.00\n}'}/></label><button className="create modal-submit" onClick={() => { setModal(false); notify('Event accepted and queued.'); }}>Queue event</button></div></div>}
    {toast && <div className="toast"><ShieldCheck size={17}/>{toast}</div>}
  </div>
}
function Metric({ icon, tone, label, value, trend, detail }: { icon: React.ReactNode; tone: string; label: string; value: string; trend: string; detail: string }) { return <div className="metric"><div className={'metric-icon '+tone}>{icon}</div><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-foot"><span className="trend">↗ {trend}</span> {detail}</div></div> }
createRoot(document.getElementById('root')!).render(<App/>);
