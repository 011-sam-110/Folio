// What sits where the account menu would be, for someone who has no account.
//
// The sidebar footer is where people look to find out who they are signed in as, so
// leaving it blank in guest mode would answer that question with nothing. It says
// "Guest", says the work is unsaved, and offers the one action that fixes both.
import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { useGuestWorkPresent } from './guestMode';
import './guest.css';

export default function GuestAccountRow() {
  const hasWork = useGuestWorkPresent();
  return (
    <div className="sidebar-account guest-account">
      <div className="guest-account__row">
        <span className="sidebar-account__avatar guest-account__avatar" aria-hidden="true">
          <Icon name="smile" size={14} />
        </span>
        <span className="sidebar-account__identity">
          <span className="sidebar-account__name">Guest</span>
          <span className="guest-account__warn">{hasWork ? 'Not saved anywhere' : 'Nothing is saved'}</span>
        </span>
      </div>
      <Link className="guest-account__cta" to="/signup">
        Make an account to keep this
      </Link>
    </div>
  );
}
