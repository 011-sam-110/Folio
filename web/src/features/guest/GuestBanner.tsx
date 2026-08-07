// The standing reminder that none of this is saved.
//
// A toast was the wrong shape for it: the fact is true for the whole session, not for the
// three seconds after someone opts in, and the moment it matters most (twenty minutes into
// a lecture) is the moment a toast is long gone. So it is a strip above the page content,
// present on every route including the editor, and it cannot be dismissed - a dismissed
// warning about unsaved work is a warning that was not given.
import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { storageUsage } from './guestStore';
import { useGuest, useGuestWorkPresent } from './guestMode';
import './guest.css';

export default function GuestBanner() {
  const guest = useGuest();
  const hasWork = useGuestWorkPresent();
  if (!guest) return null;

  const { nearlyFull } = storageUsage();

  return (
    <div className="guest-banner" role="status" data-testid="guest-banner">
      <Icon name="alert-circle" size={15} />
      <span className="guest-banner__text">
        <strong>Nothing here is saved.</strong>{' '}
        {nearlyFull
          ? 'This browser is nearly out of room for it, too. Make an account now or export what you have.'
          : 'You are trying Unote without an account, so these notes live in this browser only and go when it is cleared.'}
      </span>
      <Link className="guest-banner__cta" to="/signup">
        Make an account
      </Link>
      {hasWork && (
        <Link className="guest-banner__alt" to="/login">
          Sign in
        </Link>
      )}
    </div>
  );
}
