// Signed-in identity + account actions, rendered in the sidebar footer area.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ContextMenu, { menuDivider, menuItem, menuLabel } from '../../components/ContextMenu';
import Icon from '../../components/Icon';
import { toast } from '../../components/Toast';
import { errorMessage } from '../../lib/format';
import { useAuth } from './AuthContext';
import ChangePasswordModal from './ChangePasswordModal';
import './auth.css';

/** First letter of the display name, falling back to the email — a name is optional
 *  at signup, but there is always an email. */
function initial(displayName: string, email: string): string {
  const source = displayName.trim() || email;
  return (source[0] ?? '?').toUpperCase();
}

export default function AccountMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [passwordOpen, setPasswordOpen] = useState(false);

  if (!user) return null;

  async function signOut() {
    try {
      await logout();
      // Explicit navigation rather than waiting for the guard: this leaves /login as a
      // clean history entry instead of one carrying a "come back here" redirect.
      navigate('/login', { replace: true });
    } catch (e) {
      toast(errorMessage(e, 'Could not sign out'), 'error');
    }
  }

  return (
    <div className="sidebar-account">
      <ContextMenu
        triggerClassName="sidebar-account__trigger"
        ariaLabel={`Account menu for ${user.displayName || user.email}`}
        trigger={
          <>
            <span className="sidebar-account__avatar" aria-hidden="true">
              {initial(user.displayName, user.email)}
            </span>
            <span className="sidebar-account__identity">
              <span className="sidebar-account__name">{user.displayName || user.email}</span>
              {/* Hidden when it would just repeat the name above it. */}
              {user.displayName && <span className="sidebar-account__email">{user.email}</span>}
            </span>
            <span className="sidebar-account__chevron" aria-hidden="true">
              <Icon name="chevron-down" size={14} />
            </span>
          </>
        }
        items={[
          menuLabel('signed-in', `Signed in as ${user.email}`),
          menuItem({
            key: 'password',
            label: 'Change password',
            icon: 'lock',
            onSelect: () => setPasswordOpen(true),
          }),
          menuDivider('d1'),
          menuItem({ key: 'signout', label: 'Sign out', icon: 'log-out', onSelect: signOut }),
        ]}
      />

      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </div>
  );
}
