// Shared chrome + form primitives for the two auth screens. These render outside the
// app shell (no sidebar), so they carry their own wordmark and theme toggle.
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { useTheme } from '../../lib/theme';
import './auth.css';

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  // Optional: the recovery-key screens deliberately offer no way to navigate
  // away, since leaving loses the key permanently.
  footer?: ReactNode;
}) {
  const [theme, , toggleTheme] = useTheme();

  return (
    <div className="auth-page">
      <button
        type="button"
        className="icon-btn auth-page__theme"
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={toggleTheme}
      >
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
      </button>

      <main className="auth-card">
        <div className="auth-card__brand">
          <span className="auth-card__mark" aria-hidden="true">
            📓
          </span>
          <span className="auth-card__wordmark">Folio</span>
        </div>

        <h1 className="auth-card__title">{title}</h1>
        <p className="auth-card__subtitle">{subtitle}</p>

        {children}
      </main>

      {footer ? <p className="auth-alt">{footer}</p> : null}
    </div>
  );
}

/** The "no account? / already have one?" line under the card. */
export function AuthAltLink({ prompt, to, label }: { prompt: string; to: string; label: string }) {
  return (
    <>
      {prompt}{' '}
      <Link className="auth-alt__link" to={to}>
        {label}
      </Link>
    </>
  );
}

/** Form-level failure (the server's message). Announced, because the submit button
 *  that caused it keeps focus and a sighted-only error would be silent. */
export function AuthAlert({ message }: { message: string }) {
  return (
    <div className="auth-alert" role="alert">
      <Icon name="alert-circle" size={15} />
      <span>{message}</span>
    </div>
  );
}

export interface FieldProps {
  label: string;
  type: 'text' | 'email' | 'password';
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  /** Shown beneath the input, and wired to aria-describedby / aria-invalid. */
  error?: string | null;
  hint?: ReactNode;
  optional?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  disabled?: boolean;
  onBlur?: () => void;
}

export function Field({
  label,
  type,
  value,
  onChange,
  autoComplete,
  error,
  hint,
  optional,
  autoFocus,
  placeholder,
  disabled,
  onBlur,
}: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const [revealed, setRevealed] = useState(false);

  const isPassword = type === 'password';
  // Swapping the rendered type is what lets a password be read back; autoComplete stays
  // put so password managers still recognise the field in either state.
  const inputType = isPassword && revealed ? 'text' : type;

  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className={`auth-field${error ? ' has-error' : ''}`}>
      <label className="auth-field__label" htmlFor={id}>
        <span>{label}</span>
        {optional && <span className="auth-field__optional">Optional</span>}
      </label>

      <div className="auth-field__control">
        <input
          id={id}
          className="text-input auth-field__input"
          type={inputType}
          value={value}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          autoCapitalize={type === 'email' ? 'none' : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        />
        {isPassword && (
          <button
            type="button"
            className="auth-field__reveal"
            // aria-pressed rather than a label swap: screen-reader users get the toggle
            // state without the accessible name changing under them mid-interaction.
            aria-pressed={revealed}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            tabIndex={-1}
            onClick={() => setRevealed((r) => !r)}
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
        )}
      </div>

      {error && (
        <p className="auth-field__error" id={errorId}>
          {error}
        </p>
      )}
      {hint && (
        <div className="auth-field__hint" id={hintId}>
          {hint}
        </div>
      )}
    </div>
  );
}
