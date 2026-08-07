// The honest "this one needs a server" panel, for pages a guest can reach but not use.
//
// Rendered above the page rather than in place of it, so the surface still shows what it
// would look like with an account instead of becoming a dead end.
import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { useGuest } from './guestMode';
import './guest.css';

export default function GuestGate({ title, detail }: { title: string; detail: string }) {
  const guest = useGuest();
  if (!guest) return null;
  return (
    <div className="guest-gate" data-testid="guest-gate">
      <Icon name="alert-circle" size={16} />
      <div className="guest-gate__body">
        <div className="guest-gate__title">{title}</div>
        <div className="guest-gate__detail">{detail}</div>
        <Link className="guest-gate__cta" to="/signup">
          Make an account
        </Link>
      </div>
    </div>
  );
}
