import { useEffect, useState } from 'react';
import { Check, ClipboardCheck, Pencil, Plus } from 'lucide-react';
import './AssignmentLifecycle.css';

type Role = 'fundi' | 'foreman' | 'assessor' | 'administrator';
type Assignment = {
  id: string;
  job_id: string;
  job_title: string;
  job_trade: string;
  job_location: string;
  worker_id: string;
  worker_name: string;
  task: string;
  start_date: string;
  end_date: string;
  payment: number;
  status: string;
};
type Detail = {
  assignment: Assignment;
  attendance: Array<{ id: string; status: string; date: string; verification_status: string }>;
  progress: Array<{ id: string; details: string; created_at: string; actor_name: string; actor_role: string }>;
  review?: { rating: number; feedback: string; created_at: string };
};
type Props = {
  role: Role;
  assignments: Assignment[];
  busy: boolean;
  onLoad: (id: string) => Promise<Detail>;
  onEdit: (id: string, values: Record<string, unknown>) => void;
  onStatus: (id: string, status: string) => void;
  onProgress: (id: string, progress: string) => void;
  onAttendance: (id: string, values: Record<string, unknown>) => void;
  onAttendanceEdit: (id: string, values: Record<string, unknown>) => void;
  onReview: (values: Record<string, unknown>) => void;
};

export default function AssignmentLifecycle(props: Props) {
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [task, setTask] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [payment, setPayment] = useState('');
  const [attendanceDate, setAttendanceDate] = useState(new Date().toISOString().slice(0, 10));
  const [attendanceStatus, setAttendanceStatus] = useState('present');
  const [rating, setRating] = useState('5');
  const [feedback, setFeedback] = useState('');
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let active = true;
    props.onLoad(selected).then((result) => {
      if (!active) return;
      setDetail(result);
      setTask(result.assignment.task || '');
      setStartDate(result.assignment.start_date || '');
      setEndDate(result.assignment.end_date || '');
      setPayment(String(result.assignment.payment ?? 0));
      setError('');
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Could not load assignment details.');
    });
    return () => { active = false; };
  }, [selected, props.assignments]);

  const selectedAssignment = props.assignments.find((assignment) => assignment.id === selected);

  return <section className="assignment-workspace">
    {error && <div className="alert error">{error}</div>}
    {props.busy && <div className="lifecycle-loading" role="status">Saving assignment changes...</div>}
    {!props.assignments.length && <div className="empty">{props.role === 'fundi' ? 'Your accepted assignments and work history will appear here.' : 'No assignments yet. Assign a worker from an accepted application.'}</div>}
    <div className="assignment-layout">
      <div className="assignment-list" aria-label="Assignments">
        {props.assignments.map((assignment) => <button
          type="button" className={`assignment-list-item ${selected === assignment.id ? 'selected' : ''}`}
          key={assignment.id} onClick={() => { setSelected(assignment.id); setEditing(false); }}>
          <strong>{assignment.job_title || assignment.task || 'Work assignment'}</strong>
          <span>{props.role === 'fundi' ? assignment.job_location : assignment.worker_name}</span>
          <span className={`assignment-status ${assignment.status}`}>{assignment.status.replace('_', ' ')}</span>
        </button>)}
      </div>
      {selected && selectedAssignment && <div className="assignment-detail">
        <div className="assignment-detail-head">
          <div><h2>{selectedAssignment.job_title || selectedAssignment.task}</h2>
            <p>{selectedAssignment.job_trade} · {selectedAssignment.job_location}{props.role !== 'fundi' ? ` · ${selectedAssignment.worker_name}` : ''}</p>
          </div>
          <span className={`assignment-status ${selectedAssignment.status}`}>{selectedAssignment.status.replace('_', ' ')}</span>
        </div>
        <div className="assignment-facts">
          <span><b>Task</b>{selectedAssignment.task}</span>
          <span><b>Start</b>{selectedAssignment.start_date || 'Not set'}</span>
          <span><b>End</b>{selectedAssignment.end_date || 'Not set'}</span>
          <span><b>Payment</b>KES {Number(selectedAssignment.payment || 0).toLocaleString('en-KE')}</span>
        </div>
        {props.role !== 'fundi' && <div className="assignment-actions">
          <button type="button" className="small-btn" onClick={() => setEditing(!editing)}><Pencil size={14}/> {editing ? 'Cancel edit' : 'Edit assignment'}</button>
          {selectedAssignment.status === 'assigned' && <button type="button" className="small-btn" disabled={props.busy} onClick={() => props.onStatus(selected, 'in_progress')}>Start work</button>}
          {['assigned', 'in_progress', 'active'].includes(selectedAssignment.status) && <button type="button" className="small-btn danger" disabled={props.busy} onClick={() => {
            if (window.confirm('Cancel this assignment? Its attendance and work history will be preserved.')) props.onStatus(selected, 'cancelled');
          }}>Cancel assignment</button>}
          {['in_progress', 'active'].includes(selectedAssignment.status) && <button type="button" className="small-btn success" disabled={props.busy} onClick={() => {
            if (window.confirm('Mark this assignment as completed? Attendance can no longer be changed.')) props.onStatus(selected, 'completed');
          }}><Check size={14}/> Complete</button>}
        </div>}
        {editing && props.role !== 'fundi' && <form className="assignment-edit-form" onSubmit={(event) => {
          event.preventDefault();
          props.onEdit(selected, { task, startDate, endDate, payment: Number(payment) });
          setEditing(false);
        }}>
          <label>Task<input maxLength={300} required value={task} onChange={(event) => setTask(event.target.value)}/></label>
          <label>Start date<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)}/></label>
          <label>End date<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)}/></label>
          <label>Payment (KES)<input type="number" min="0" step="any" required value={payment} onChange={(event) => setPayment(event.target.value)}/></label>
          <button type="submit" className="primary compact" disabled={props.busy}>Save assignment</button>
        </form>}
        <div className="assignment-section">
          <h3><ClipboardCheck size={17}/> Attendance</h3>
          {detail?.attendance.map((record) => <div className="assignment-record" key={record.id}>
            <span>{record.date} · {record.status} · {record.verification_status}</span>
            {props.role !== 'fundi' && !['completed', 'cancelled'].includes(selectedAssignment.status) && <button type="button" className="small-btn" onClick={() => {
              const next = window.prompt('Update attendance status (present, late or absent):', record.status);
              if (next && ['present', 'late', 'absent'].includes(next)) {
                props.onAttendanceEdit(record.id, { status: next, date: record.date });
              }
            }}>Edit</button>}
          </div>)}
          {!detail?.attendance.length && <p className="muted">No attendance recorded.</p>}
          {props.role !== 'fundi' && !['completed', 'cancelled'].includes(selectedAssignment.status) && <form className="assignment-inline-form" onSubmit={(event) => {
            event.preventDefault();
            props.onAttendance(selected, { date: attendanceDate, status: attendanceStatus });
          }}>
            <label>Date<input type="date" required value={attendanceDate} onChange={(event) => setAttendanceDate(event.target.value)}/></label>
            <label>Status<select value={attendanceStatus} onChange={(event) => setAttendanceStatus(event.target.value)}><option value="present">Present</option><option value="late">Late</option><option value="absent">Absent</option></select></label>
            <button type="submit" className="primary compact" disabled={props.busy}><Plus size={14}/> Record</button>
          </form>}
        </div>
        <div className="assignment-section">
          <h3>Progress updates</h3>
          {detail?.progress.map((entry) => <article className="assignment-progress" key={entry.id}>
            <p>{entry.details}</p><small>{entry.actor_name || entry.actor_role} · {new Date(entry.created_at).toLocaleString()}</small>
          </article>)}
          {!detail?.progress.length && <p className="muted">No progress updates yet.</p>}
          {props.role === 'fundi' && ['assigned', 'in_progress', 'active'].includes(selectedAssignment.status) && <form className="assignment-progress-form" onSubmit={(event) => {
            event.preventDefault();
            props.onProgress(selected, progress);
            setProgress('');
          }}>
            <label>Post progress<textarea required maxLength={1000} value={progress} onChange={(event) => setProgress(event.target.value)} placeholder="Share a concise work update (up to 1,000 characters)."/></label>
            <button type="submit" className="primary compact" disabled={props.busy}>Post update</button>
          </form>}
        </div>
        <div className="assignment-section">
          <h3>Performance review</h3>
          {detail?.review
            ? <p>{detail.review.rating}/5 · {detail.review.feedback || 'No written feedback.'}</p>
            : props.role !== 'fundi' && detail?.attendance.some((record) =>
              record.verification_status === 'verified' && ['present', 'late'].includes(record.status))
              && selectedAssignment.status !== 'cancelled'
              ? <form className="assignment-review-form" onSubmit={(event) => {
                event.preventDefault();
                props.onReview({
                  assignmentId: selected,
                  workerId: selectedAssignment.worker_id,
                  rating: Number(rating),
                  feedback,
                });
                setFeedback('');
              }}>
                <label>Rating<select value={rating} onChange={(event) => setRating(event.target.value)}><option value="5">5 — Excellent</option><option value="4">4 — Very good</option><option value="3">3 — Good</option><option value="2">2 — Needs improvement</option><option value="1">1 — Unsatisfactory</option></select></label>
                <label>Feedback<textarea maxLength={1500} value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="Share job-related performance feedback (optional)."/></label>
                <button type="submit" className="primary compact" disabled={props.busy}>Submit review</button>
              </form>
              : <p className="muted">A review is available after verified present or late attendance.</p>}
        </div>
      </div>}
      {!selected && props.assignments.length > 0 && <div className="assignment-detail assignment-placeholder">Choose an assignment to view its details and activity.</div>}
    </div>
  </section>;
}
