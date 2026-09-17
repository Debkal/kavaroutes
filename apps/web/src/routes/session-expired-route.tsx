import { Link } from "react-router";
export function Component() { return <main id="main-content" className="message-page"><h1>Session expired</h1><p role="alert">Your session is no longer active. Sign in again before continuing.</p><Link to="/dispatch">Return to sign in</Link></main>; }
