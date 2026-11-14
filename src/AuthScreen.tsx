import { useState } from 'react';
import { CheckCircle2, HardHat } from 'lucide-react';
import { apiFetch } from './api-client';

type Role = 'fundi' | 'foreman' | 'assessor' | 'administrator';
type User = { id: string; name: string; email: string; role: Role };
type AuthMode = 'login' | 'register' | 'forgot' | 'reset';
type AuthResult = { token: string; user: User };

type AuthScreenProps = {
  onAuthenticated: (result: AuthResult) => Promise<void>;
};

const trades = ['Masonry', 'Electrical', 'Plumbing', 'Carpentry', 'Painting', 'Tiling', 'Welding', 'Roofing', 'General construction'];

async function authRequest(url: string, body: Record<string, string>) {
  const response = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export default function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const resetToken = new URLSearchParams(window.location.search).get('resetToken') || '';
  const [mode, setMode] = useState<AuthMode>(resetToken ? 'reset' : 'login');
  const [form, setForm] = useState<Record<string, string>>({ role: 'fundi', availability: 'Available' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  function set(key: string, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function changeMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError('');
    setNotice('');
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (mode === 'forgot') {
        const result = await authRequest('/api/auth/forgot-password', { email: form.email || '' });
        setNotice(result.message);
      } else if (mode === 'reset') {
        if (form.password !== form.confirmPassword) throw new Error('The passwords do not match.');
        const result = await authRequest('/api/auth/reset-password', { token: resetToken, password: form.password || '' });
        window.history.replaceState(null, '', window.location.pathname);
        set('password', '');
        set('confirmPassword', '');
        changeMode('login');
        setNotice(result.message);
      } else {
        const result: AuthResult = await authRequest(
          mode === 'login' ? '/api/auth/login' : '/api/auth/register',
          form,
        );
        localStorage.setItem('fundiconnect_token', result.token);
        await onAuthenticated(result);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'login' ? 'Welcome back'
    : mode === 'register' ? 'Create your account'
      : mode === 'forgot' ? 'Forgot your password?'
        : 'Set a new password';
  const description = mode === 'login' ? 'Sign in to continue to your workspace.'
    : mode === 'register' ? 'Join the FundiConnect construction network.'
      : mode === 'forgot' ? 'Enter your email to request a password reset link.'
        : 'Choose a new password for your account.';

  return (
    <main className="auth-layout">
      <section className="auth-aside">
        <div className="brand"><span className="brandmark"><HardHat /></span>Fundi<span>Connect</span></div>
        <p className="eyebrow">KENYA'S CONSTRUCTION WORKFORCE NETWORK</p>
        <h1>Connecting skills to opportunity.</h1>
        <p>Discover work, verify practical skills and coordinate construction teams in one place.</p>
        <div className="auth-points">
          <span><CheckCircle2 /> Skills and evidence records</span>
          <span><CheckCircle2 /> Explainable job matching</span>
          <span><CheckCircle2 /> Workforce coordination</span>
        </div>
      </section>
      <section className="auth-card">
        <h2>{title}</h2>
        <p>{description}</p>
        {error && <div className="alert error">{error}</div>}
        {notice && <div className="alert success">{notice}</div>}
        <form onSubmit={submit} className="form-stack">
          {mode === 'register' && <>
            <label>Full name<input required maxLength={100} value={form.name || ''} onChange={(event) => set('name', event.target.value)} placeholder="Your full name" /></label>
            <label>Account type<select value={form.role} onChange={(event) => set('role', event.target.value)}>
              <option value="fundi">Fundi / Skilled worker</option>
              <option value="foreman">Foreman</option>
            </select></label>
            {form.role === 'fundi' && <>
              <label>Trade<select value={form.trade || ''} onChange={(event) => set('trade', event.target.value)}>
                <option value="">Select trade</option>
                {trades.map((trade) => <option key={trade}>{trade}</option>)}
              </select></label>
              <label>Experience duration<input type="number" min="0.01" step="any" required value={form.experience || ''} onChange={(event) => set('experience', event.target.value)} /></label>
              <label>Experience unit<select value={form.experienceUnit || 'years'} onChange={(event) => set('experienceUnit', event.target.value)}>
                <option value="days">Days</option>
                <option value="months">Months</option>
                <option value="years">Years</option>
              </select></label>
              <label className="full">Skills (comma-separated)<input value={form.skills || ''} onChange={(event) => set('skills', event.target.value)} placeholder="e.g. bricklaying, concrete finishing" /></label>
            </>}
            <label>Phone<input value={form.phone || ''} onChange={(event) => set('phone', event.target.value)} /></label>
            <label>Location<input value={form.location || ''} onChange={(event) => set('location', event.target.value)} placeholder="e.g. Nairobi" /></label>
            {form.role === 'fundi' && <label>Availability<select value={form.availability || 'Available'} onChange={(event) => set('availability', event.target.value)}>
              <option value="Available">Available</option>
              <option value="Unavailable">Unavailable</option>
            </select></label>}
          </>}
          {mode !== 'reset' && <label>Email address<input type="email" maxLength={160} required value={form.email || ''} onChange={(event) => set('email', event.target.value)} placeholder="you@example.com" /></label>}
          {(mode === 'login' || mode === 'register') && <label>Password<input type="password" minLength={8} maxLength={200} required value={form.password || ''} onChange={(event) => set('password', event.target.value)} placeholder="At least 8 characters" /></label>}
          {mode === 'reset' && <>
            <label>New password<input type="password" minLength={8} maxLength={200} required value={form.password || ''} onChange={(event) => set('password', event.target.value)} placeholder="At least 8 characters" /></label>
            <label>Confirm new password<input type="password" minLength={8} maxLength={200} required value={form.confirmPassword || ''} onChange={(event) => set('confirmPassword', event.target.value)} /></label>
          </>}
          <button className="primary" disabled={busy}>{busy ? 'Please wait…'
            : mode === 'login' ? 'Sign in'
              : mode === 'register' ? 'Create account'
                : mode === 'forgot' ? 'Send reset link'
                  : 'Reset password'}</button>
        </form>
        <div className="switch-auth">
          {mode === 'login' && <>Don't have an account? <button type="button" onClick={() => changeMode('register')}>Create account</button><br /><button type="button" onClick={() => changeMode('forgot')}>Forgot password?</button></>}
          {mode === 'register' && <>Already registered? <button type="button" onClick={() => changeMode('login')}>Sign in</button></>}
          {(mode === 'forgot' || mode === 'reset') && <button type="button" onClick={() => changeMode('login')}>Back to sign in</button>}
        </div>
        <small className="muted">Independent local edition · Data stays in your local database.</small>
      </section>
    </main>
  );
}
