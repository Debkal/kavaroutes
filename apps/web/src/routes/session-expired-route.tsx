import { Link } from "react-router";
export function Component() { return <main id="main-content" className="message-page"><h1>Session expired</h1><p role="alert">Refresh your local synthetic session before continuing.</p><Link to="/dispatch">Restart synthetic session</Link></main>; }
