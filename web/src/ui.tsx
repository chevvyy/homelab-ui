// Shared building blocks: badges, meters, problem cards, dialogs, toasts and formatters.
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import type { AppStatus, Problem } from './types';

// ---- Formatters -----------------------------------------------------------------------------

export function fmtBytes(n?: number): string {
  if (n == null || !isFinite(n)) return '–';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
}

export function fmtPct(v?: number): string {
  return v == null || !isFinite(v) ? '–' : `${Math.round(v * 100)}%`;
}

export function fmtAgo(t?: string | number): string {
  if (!t) return '–';
  const ms = Date.now() - (typeof t === 'number' ? t : Date.parse(t));
  if (ms < 0 || !isFinite(ms)) return '–';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function fmtUptime(seconds?: number): string {
  if (!seconds) return '–';
  return fmtAgo(Date.now() - seconds * 1000);
}

// ---- Status ---------------------------------------------------------------------------------

const STATUS_LABEL: Record<AppStatus, string> = {
  healthy: 'Healthy',
  progressing: 'Updating',
  degraded: 'Degraded',
  failed: 'Failing',
  stopped: 'Stopped',
  completed: 'Completed',
  scheduled: 'Scheduled',
};

export function StatusBadge({ status }: { status: AppStatus }) {
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'off' }) {
  return <span className={`dot dot-${tone}`} aria-hidden />;
}

export function Meter({ value, label, title }: { value?: number; label?: string; title?: string }) {
  const v = value == null || !isFinite(value) ? 0 : Math.max(0, Math.min(1, value));
  const tone = v > 0.9 ? 'bad' : v > 0.75 ? 'warn' : 'ok';
  return (
    <div className="meter" title={title}>
      <div className="meter-track">
        <div className={`meter-fill meter-${tone}`} style={{ width: `${v * 100}%` }} />
      </div>
      {label && <span className="meter-label">{label}</span>}
    </div>
  );
}

export function ProblemCard({ p, logs }: { p: Problem; logs?: string }) {
  return (
    <div className={`problem problem-${p.severity}`}>
      <div className="problem-title">{p.title}</div>
      {p.cause && <div className="problem-cause">{p.cause}</div>}
      {p.fix && (
        <div className="problem-fix">
          <strong>Next step:</strong> {p.fix}
        </div>
      )}
      {logs && (
        <details open>
          <summary>Last log lines{p.pod ? ` (${p.pod})` : ''}</summary>
          <pre className="logbox small">{logs}</pre>
        </details>
      )}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const p: Problem =
    error instanceof ApiError
      ? { severity: 'error', title: error.problem.title ?? error.message, cause: error.problem.cause ?? '', fix: error.problem.fix ?? '' }
      : { severity: 'error', title: error instanceof Error ? error.message : String(error), cause: '', fix: '' };
  return <ProblemCard p={p} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: ReactNode }[] }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'tab active' : 'tab'} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---- Dialogs --------------------------------------------------------------------------------

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

type ConfirmOpts = { title: string; body?: ReactNode; confirm?: string; danger?: boolean; typeToConfirm?: string };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState('');
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => (setTyped(''), setReq({ ...o, resolve }))), []);
  const close = (v: boolean) => {
    req?.resolve(v);
    setReq(null);
  };
  const blocked = !!req?.typeToConfirm && typed !== req.typeToConfirm;
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {req && (
        <Modal
          title={req.title}
          onClose={() => close(false)}
          footer={
            <>
              <button className="btn" onClick={() => close(false)}>
                Cancel
              </button>
              <button className={req.danger ? 'btn btn-danger' : 'btn btn-primary'} disabled={blocked} onClick={() => close(true)} autoFocus={!req.typeToConfirm}>
                {req.confirm ?? 'Confirm'}
              </button>
            </>
          }
        >
          {req.body}
          {req.typeToConfirm && (
            <label className="field">
              <span>
                Type <code>{req.typeToConfirm}</code> to confirm
              </span>
              <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !blocked && close(true)} />
            </label>
          )}
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmCtx);

// ---- Toasts ---------------------------------------------------------------------------------

type Toast = { id: number; tone: 'ok' | 'bad' | 'info'; text: ReactNode };
const ToastCtx = createContext<(tone: Toast['tone'], text: ReactNode) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((tone: Toast['tone'], text: ReactNode) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 9000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// Runs an action with a busy flag and success / error toasts.
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, success?: ReactNode): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        if (success) toast('ok', success);
        return r;
      } catch (e) {
        const msg = e instanceof ApiError ? [e.problem.title, e.problem.cause].filter(Boolean).join(': ') : e instanceof Error ? e.message : String(e);
        toast('bad', msg);
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}

export function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="icon-btn"
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? '✓' : '⧉'}
    </button>
  );
}
