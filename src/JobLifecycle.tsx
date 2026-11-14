import { useState } from 'react';
import { BriefcaseBusiness, Check, Pencil, X } from 'lucide-react';
import './JobLifecycle.css';

type Role = 'fundi' | 'foreman' | 'assessor' | 'administrator';
type Job = {
  id: string;
  title: string;
  trade: string;
  location: string;
  description: string;
  pay: number;
  duration: string;
  start_date: string;
  workers_needed: number;
  min_experience: number;
  min_experience_unit?: string;
  required_skills?: string | string[];
  verification_required: number;
  status?: string;
  foreman_name?: string;
};
type Applicant = {
  id: string;
  name: string;
  trade?: string;
  location?: string;
  experience?: number;
  experience_unit?: string;
  skills?: string | string[];
  availability?: string;
  verification_status?: string;
  bio?: string;
};
type Application = {
  id: string;
  job_id: string;
  fundi_id?: string;
  job_title: string;
  trade: string;
  location: string;
  message: string;
  status: string;
  created_at: string;
  updated_at?: string;
  fundi_name?: string;
  applicant_trade?: string;
  applicant_location?: string;
  applicant_experience?: number;
  applicant_experience_unit?: string;
  applicant_skills?: string | string[];
  applicant_availability?: string;
  applicant_verification_status?: string;
  applicant_bio?: string;
  applicant?: Applicant;
};
type Assignment = { job_id: string; worker_id: string; status: string };

type Props = {
  view: 'jobs' | 'applications';
  role: Role;
  jobs: Job[];
  applications: Application[];
  assignments: Assignment[];
  busy: boolean;
  onApply: (jobId: string, message: string) => void;
  onEditJob: (jobId: string, values: Record<string, unknown>) => void;
  onChangeJobStatus: (jobId: string, status: 'open' | 'closed') => void;
  onReviewApplication: (applicationId: string, status: 'accepted' | 'rejected') => void;
  onEditApplication: (applicationId: string, message: string) => void;
  onWithdrawApplication: (applicationId: string) => void;
  onCreateAssignment: (applicationId: string) => void;
};

function skillsText(value?: string | string[]) {
  if (Array.isArray(value)) return value.join(', ');
  if (!value) return '';
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.join(', ') : value;
  } catch {
    return value;
  }
}

function dateText(value: string) {
  return value ? new Date(value).toLocaleDateString() : '—';
}

function Status({ value }: { value: string }) {
  return <span className={`lifecycle-status ${value}`}>{value}</span>;
}

export default function JobLifecycle(props: Props) {
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [editingJob, setEditingJob] = useState('');
  const [jobForm, setJobForm] = useState<Record<string, string>>({});
  const [editingApplication, setEditingApplication] = useState('');
  const [applicationMessage, setApplicationMessage] = useState('');
  const ownedApplications = new Map<string, Application[]>();
  for (const application of props.applications) {
    const entries = ownedApplications.get(application.job_id) || [];
    entries.push(application);
    ownedApplications.set(application.job_id, entries);
  }

  if (props.view === 'applications') {
    return <section className="lifecycle-list" aria-label="Application history">
      {props.busy && <div className="lifecycle-loading" role="status">Saving your changes...</div>}
      {props.applications.map((application) => <article className="lifecycle-card" key={application.id}>
        <div className="lifecycle-card-head">
          <div><h3>{application.job_title}</h3><p>{application.trade} · {application.location}</p></div>
          <Status value={application.status}/>
        </div>
        <p className="lifecycle-message">{application.message || 'No cover message provided.'}</p>
        <small>Applied {dateText(application.created_at)}{application.updated_at ? ` · Updated ${dateText(application.updated_at)}` : ''}</small>
        {application.status === 'pending' && <div className="lifecycle-actions">
          {editingApplication === application.id
            ? <div className="lifecycle-edit-message">
                <label>Application message<textarea maxLength={1000} value={applicationMessage} onChange={(event) => setApplicationMessage(event.target.value)}/></label>
                <button className="primary compact" disabled={props.busy} onClick={() => {
                  props.onEditApplication(application.id, applicationMessage);
                  setEditingApplication('');
                }}><Check size={15}/> Save</button>
                <button className="small-btn" onClick={() => setEditingApplication('')}>Cancel</button>
              </div>
            : <button className="small-btn" disabled={props.busy} onClick={() => {
                setApplicationMessage(application.message || '');
                setEditingApplication(application.id);
              }}><Pencil size={14}/> Edit message</button>}
          <button className="small-btn danger" disabled={props.busy} onClick={() => {
            if (window.confirm('Withdraw this application? This cannot be undone.')) props.onWithdrawApplication(application.id);
          }}><X size={14}/> Withdraw</button>
        </div>}
      </article>)}
      {!props.applications.length && <div className="empty">You have not submitted any applications yet. Browse open jobs to get started.</div>}
    </section>;
  }

  return <section className="lifecycle-list" aria-label={props.role === 'fundi' ? 'Available jobs' : 'Job management'}>
    {props.busy && <div className="lifecycle-loading" role="status">Saving your changes...</div>}
    {props.jobs.map((job) => {
      const applications = ownedApplications.get(job.id) || [];
      const isEditing = editingJob === job.id;
      return <article className="lifecycle-card" key={job.id}>
        <div className="lifecycle-card-head">
          <div className="lifecycle-title"><span className="job-icon"><BriefcaseBusiness/></span><div><h3>{job.title}</h3><p>{job.trade} · {job.location}{job.duration ? ` · ${job.duration}` : ''}</p></div></div>
          <Status value={job.status || 'open'}/>
        </div>
        <p className="lifecycle-description">{job.description || 'No additional description.'}</p>
        <div className="lifecycle-details">
          <span><b>Pay</b> KES {Number(job.pay || 0).toLocaleString('en-KE')}</span>
          <span><b>Workers</b> {job.workers_needed}</span>
          <span><b>Experience</b> {job.min_experience} {job.min_experience_unit || 'years'}</span>
          <span><b>Skills</b> {skillsText(job.required_skills) || 'None specified'}</span>
          <span><b>Verified skills</b> {job.verification_required ? 'Required' : 'Not required'}</span>
          {job.start_date && <span><b>Starts</b> {dateText(job.start_date)}</span>}
          {job.foreman_name && <span><b>Posted by</b> {job.foreman_name}</span>}
        </div>
        {props.role === 'fundi'
          ? job.status !== 'closed' && <div className="lifecycle-apply">
              <label>Message to employer (optional)<textarea maxLength={1000} value={messages[job.id] || ''} onChange={(event) => setMessages((current) => ({ ...current, [job.id]: event.target.value }))}/></label>
              <button className="primary compact" disabled={props.busy} onClick={() => props.onApply(job.id, messages[job.id] || '')}>Apply for this job</button>
            </div>
          : <div className="lifecycle-actions">
              <button className="small-btn" disabled={props.busy} onClick={() => {
                if (!isEditing) {
                  setJobForm({
                    title: job.title, trade: job.trade, location: job.location, description: job.description || '',
                    pay: String(job.pay ?? 0), duration: job.duration || '', startDate: job.start_date || '',
                    workersNeeded: String(job.workers_needed || 1), minExperience: String(job.min_experience || 0),
                    minExperienceUnit: job.min_experience_unit || 'years', requiredSkills: skillsText(job.required_skills),
                    verificationRequired: job.verification_required ? 'yes' : 'no',
                  });
                }
                setEditingJob(isEditing ? '' : job.id);
              }}><Pencil size={14}/> {isEditing ? 'Cancel editing' : 'Edit job'}</button>
              <button className="small-btn" disabled={props.busy} onClick={() => {
                const nextStatus = job.status === 'closed' ? 'open' : 'closed';
                const prompt = nextStatus === 'closed'
                  ? 'Close this job? New applications will no longer be accepted.'
                  : 'Reopen this job to accept new applications?';
                if (window.confirm(prompt)) props.onChangeJobStatus(job.id, nextStatus);
              }}>{job.status === 'closed' ? 'Reopen job' : 'Close job'}</button>
            </div>}
        {isEditing && <form className="lifecycle-edit-form" onSubmit={(event) => {
          event.preventDefault();
          props.onEditJob(job.id, {
            ...jobForm, pay: Number(jobForm.pay), workersNeeded: Number(jobForm.workersNeeded),
            minExperience: Number(jobForm.minExperience), verificationRequired: jobForm.verificationRequired === 'yes',
          });
          setEditingJob('');
        }}>
          <label>Title<input required maxLength={120} value={jobForm.title || ''} onChange={(event) => setJobForm((current) => ({ ...current, title: event.target.value }))}/></label>
          <label>Trade<input required maxLength={80} value={jobForm.trade || ''} onChange={(event) => setJobForm((current) => ({ ...current, trade: event.target.value }))}/></label>
          <label>Location<input required maxLength={100} value={jobForm.location || ''} onChange={(event) => setJobForm((current) => ({ ...current, location: event.target.value }))}/></label>
          <label>Pay (KES)<input required type="number" min="0" max="100000000" value={jobForm.pay || ''} onChange={(event) => setJobForm((current) => ({ ...current, pay: event.target.value }))}/></label>
          <label>Duration<input maxLength={80} value={jobForm.duration || ''} onChange={(event) => setJobForm((current) => ({ ...current, duration: event.target.value }))}/></label>
          <label>Start date<input type="date" value={jobForm.startDate || ''} onChange={(event) => setJobForm((current) => ({ ...current, startDate: event.target.value }))}/></label>
          <label>Workers needed<input required type="number" min="1" max="500" step="1" value={jobForm.workersNeeded || ''} onChange={(event) => setJobForm((current) => ({ ...current, workersNeeded: event.target.value }))}/></label>
          <label>Minimum experience<input required type="number" min="0" step="any" value={jobForm.minExperience ?? '0'} onChange={(event) => setJobForm((current) => ({ ...current, minExperience: event.target.value }))}/></label>
          <label>Experience unit<select value={jobForm.minExperienceUnit || 'years'} onChange={(event) => setJobForm((current) => ({ ...current, minExperienceUnit: event.target.value }))}><option value="days">Days</option><option value="months">Months</option><option value="years">Years</option></select></label>
          <label>Required skills<input value={jobForm.requiredSkills || ''} onChange={(event) => setJobForm((current) => ({ ...current, requiredSkills: event.target.value }))}/></label>
          <label>Require verified skills?<select value={jobForm.verificationRequired || 'no'} onChange={(event) => setJobForm((current) => ({ ...current, verificationRequired: event.target.value }))}><option value="no">No</option><option value="yes">Yes</option></select></label>
          <label className="wide">Description<textarea maxLength={2000} value={jobForm.description || ''} onChange={(event) => setJobForm((current) => ({ ...current, description: event.target.value }))}/></label>
          <button className="primary compact" disabled={props.busy}>Save changes</button>
        </form>}
        {props.role !== 'fundi' && <div className="lifecycle-applications">
          <h4>Applications received <span>{applications.length}</span></h4>
          {applications.map((application) => {
            const applicant = application.applicant;
            const skills = applicant?.skills ?? application.applicant_skills;
            return <div className="lifecycle-application" key={application.id}>
              <div className="lifecycle-card-head">
                <div><b>{applicant?.name || application.fundi_name || 'Fundi applicant'}</b><p>{applicant?.trade || application.applicant_trade || 'Trade not set'} · {applicant?.location || application.applicant_location || 'Location not set'}</p></div>
                <Status value={application.status}/>
              </div>
              <p>{application.message || 'No cover message provided.'}</p>
              <small>Applied {dateText(application.created_at)}{application.updated_at ? ` · Updated ${dateText(application.updated_at)}` : ''}</small>
              <br/>
              <small>Experience: {applicant?.experience ?? application.applicant_experience ?? 0} {applicant?.experience_unit || application.applicant_experience_unit || 'years'} · Skills: {skillsText(skills) || 'Not listed'} · Availability: {applicant?.availability || application.applicant_availability || 'Not set'} · Verification: {applicant?.verification_status || application.applicant_verification_status || 'pending'}</small>
              {(applicant?.bio || application.applicant_bio) && <p className="lifecycle-bio">{applicant?.bio || application.applicant_bio}</p>}
              {application.status === 'pending' && <div className="lifecycle-actions">
                <button className="small-btn success" disabled={props.busy} onClick={() => {
                  if (window.confirm('Accept this application? This will not create an assignment.')) props.onReviewApplication(application.id, 'accepted');
                }}><Check size={14}/> Accept</button>
                <button className="small-btn danger" disabled={props.busy} onClick={() => {
                  if (window.confirm('Reject this application? This cannot be undone.')) props.onReviewApplication(application.id, 'rejected');
                }}><X size={14}/> Reject</button>
              </div>}
              {application.status === 'accepted' && (() => {
                const workerId = applicant?.id || application.fundi_id;
                const assignment = props.assignments.find((entry) => entry.job_id === application.job_id
                  && entry.worker_id === workerId);
                return assignment
                  ? <div className="lifecycle-actions"><span className="lifecycle-status">{assignment.status.replace('_', ' ')}</span></div>
                  : <div className="lifecycle-actions"><button className="primary compact" disabled={props.busy || !workerId} onClick={() => {
                    if (window.confirm('Create a separate work assignment for this accepted applicant?')) props.onCreateAssignment(application.id);
                  }}><BriefcaseBusiness size={14}/> Create assignment</button></div>;
              })()}
            </div>;
          })}
          {!applications.length && <p className="lifecycle-empty">No applications received yet.</p>}
        </div>}
      </article>;
    })}
    {!props.jobs.length && <div className="empty">{props.role === 'fundi' ? 'No open jobs are available right now.' : 'You have not posted any jobs yet.'}</div>}
  </section>;
}
