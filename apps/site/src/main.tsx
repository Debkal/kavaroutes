import {StrictMode,useEffect,useState,type FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter,Link,Route,Routes,useLocation,useNavigate} from 'react-router';
import {api,emailSignIn,emailSignUp,getConfig,messageFor,resetPassword,socialSignIn} from './auth';
import './styles.css';

function Brand(){return <Link className="brand" to="/" aria-label="KavaRoutes home"><img src="/favicon.svg" alt="" width="34" height="34"/><span>KavaRoutes</span></Link>;}
function Layout(){
  const location=useLocation();
  useEffect(()=>{window.scrollTo(0,0);document.title=`${location.pathname==='/sign-in'?'Business sign in':location.pathname==='/sign-up'?'Create a business account':location.pathname==='/account'?'Your business account':'Your NEMT operating system'} · KavaRoutes`;},[location.pathname]);
  return <><a className="skip" href="#main">Skip to content</a><header className="header"><Brand/><nav aria-label="Main navigation">
    {location.pathname==='/'&&<a className="nav-about" href="#overview">The software</a>}
    <Link className="nav-login" to="/sign-in">Business sign in <span aria-hidden="true">↗</span></Link>
    <Link className="button small" to="/sign-up">Get started</Link>
  </nav></header>
    <Routes><Route path="/" element={<Home/>}/><Route path="/sign-in" element={<Authentication key="in" mode="in"/>}/><Route path="/sign-up" element={<Authentication key="up" mode="up"/>}/><Route path="/reset-password" element={<Reset/>}/><Route path="/account" element={<Account/>}/><Route path="*" element={<main id="main" className="auth-page"><p className="eyebrow">A small detour</p><h1>Page not found.</h1><Link to="/">Back to home</Link></main>}/></Routes>
    <footer className="footer"><span>© {new Date().getFullYear()} KavaRoutes</span><span>Made for NEMT providers.</span><a href="mailto:kavasupport@kavaroutes.com">Contact us <span aria-hidden="true">↗</span></a></footer></>;
}
function Home(){return <main id="main">
  <section className="hero"><div className="hero-copy">
    <h1>Your NEMT<br/>operating system.</h1><p className="intro">Built for non-emergency medical transportation.<br className="desktop-break"/> Dispatch, clients, and accounting, together in one place.</p>
    <div className="hero-actions"><Link className="button" to="/sign-up">Create your business account <span aria-hidden="true">↗</span></Link><a className="text-link" href="#overview">Take a look <span aria-hidden="true">↓</span></a></div>
    <p className="quiet-note">For NEMT providers and their teams.</p></div>
    <div className="asset-space" aria-hidden="true"/>
    <div className="hero-footnote"><span>Less to juggle. More room to focus.</span><span>Built around your working day.</span></div>
  </section>
  <section id="overview" className="overview"><div className="section-intro"><p className="eyebrow">One place for the day ahead</p><h2>Keep things moving.<br/>Keep things simple.</h2></div><div className="features">
    <article><span className="feature-number">01 /</span><h3>Dispatch with clarity</h3><p>Plan trips, coordinate your team, and follow the day’s work.</p></article>
    <article><span className="feature-number">02 /</span><h3>Keep clients close</h3><p>Organize client details and transportation needs in one workspace.</p></article>
    <article><span className="feature-number">03 /</span><h3>See the business side</h3><p>Bring estimates, costs, and invoicing into your daily workflow.</p></article>
  </div></section>
  <section className="subscription"><div><p className="eyebrow">Your next step</p><h2>A little more space<br/>for your business to grow.</h2><p>Create a business account today.<br/>Subscription purchases will be available soon.</p></div><div><Link className="button" to="/sign-up">Get started <span aria-hidden="true">↗</span></Link><p className="quiet-note">No payment collected at signup.</p></div></section>
</main>;}
function useAvailable(){
  const [available,setAvailable]=useState<boolean|null>(null);
  useEffect(()=>{let current=true;getConfig().then(config=>{if(current)setAvailable(config.authEnabled);}).catch(()=>{if(current)setAvailable(false);});return()=>{current=false;};},[]);
  return available;
}
function Availability({available}:{available:boolean|null}){return available===false?<p className="notice" role="status">Business sign-in is being prepared. Please check back soon.</p>:available===null?<p className="quiet-note" role="status">Checking sign-in availability…</p>:null;}
function Authentication({mode}:{mode:'in'|'up'}){
  const signup=mode==='up',navigate=useNavigate(),available=useAvailable();
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[businessName,setBusinessName]=useState('');
  const [needsBusiness,setNeedsBusiness]=useState(signup),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [showPassword,setShowPassword]=useState(false);
  async function run(action:()=>Promise<void>){setBusy(true);setError('');setNotice('');try{await action();}catch(error){if((error as {code?:string}).code==='BUSINESS_PROFILE_REQUIRED')setNeedsBusiness(true);setError(messageFor(error));}finally{setBusy(false);setPassword('');}}
  function result(value:string){if(value==='VERIFY_EMAIL')setNotice('Check your inbox to verify your email, then return here to sign in.');else navigate('/account',{replace:true});}
  function submit(event:FormEvent){event.preventDefault();void run(async()=>{
    if(signup){await emailSignUp(email,password,businessName);setNotice('Check your inbox to verify your email. Then sign in to finish setting up your business account.');}
    else result(await emailSignIn(email,password,businessName));
  });}
  function social(provider:'google'|'microsoft'){
    if(signup&&!businessName.trim()){setError('Enter your business name first.');document.getElementById('business-name')?.focus();return;}
    void run(async()=>result(await socialSignIn(provider,businessName)));
  }
  return <main id="main" className={signup?'auth-page':'auth-page sign-in-page'}><div className="auth-heading">{signup&&<p className="eyebrow">KavaRoutes for business</p>}<h1>{signup?'Room for your next chapter.':'Business sign in'}</h1>{signup&&<p>Create an account for your transportation business.</p>}</div>
    <div className="auth-card"><Availability available={available}/><form onSubmit={submit}>
      <fieldset disabled={busy||available!==true}>
        {needsBusiness&&<label htmlFor="business-name">Business name<input id="business-name" autoComplete="organization" value={businessName} onChange={event=>setBusinessName(event.target.value)} required maxLength={120}/></label>}
        <div className="social-buttons"><button type="button" onClick={()=>social('google')}><span className="provider-icon" aria-hidden="true">G</span>Continue with Google</button><button type="button" onClick={()=>social('microsoft')}><span className="microsoft-icon" aria-hidden="true"><i/><i/><i/><i/></span>Continue with Microsoft</button></div>
        <div className="divider"><span>or use your email</span></div>
        <label htmlFor="email">Email address<input id="email" type="email" autoComplete="email" inputMode="email" placeholder="you@yourbusiness.com" value={email} onChange={event=>setEmail(event.target.value)} required maxLength={254}/></label>
        <label htmlFor="password">Password<div className="password-field"><input id="password" type={showPassword?'text':'password'} autoComplete={signup?'new-password':'current-password'} minLength={signup?12:undefined} maxLength={256} value={password} onChange={event=>setPassword(event.target.value)} required aria-describedby={signup?'password-hint':undefined}/><button className="show-password" type="button" aria-label={showPassword?'Hide password':'Show password'} onClick={()=>setShowPassword(!showPassword)}>{showPassword?'Hide':'Show'}</button></div></label>
        {signup?<p id="password-hint" className="field-hint">Use at least 12 characters.</p>:<Link className="forgot" to="/reset-password">Forgot password?</Link>}
        <button className="button submit" type="submit">{busy?'Please wait…':signup?'Create business account':'Sign in'}{!busy&&<span aria-hidden="true">↗</span>}</button>
      </fieldset>
    </form>{error&&<p className="error" role="alert">{error}</p>}{notice&&<div className="notice" role="status"><p>{notice}</p>{signup&&<Link to="/sign-in">Continue to sign in</Link>}</div>}
    <p className="account-switch">{signup?'Already have an account?':'New to KavaRoutes?'} <Link to={signup?'/sign-in':'/sign-up'}>{signup?'Sign in':'Create a business account'}</Link></p></div>
    {signup&&<p className="auth-footnote">For business owners and authorized teams.</p>}</main>;
}
function Reset(){
  const available=useAvailable();const [email,setEmail]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  async function submit(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{await resetPassword(email);setMessage('If this email has an account, you’ll receive a password reset link shortly.');}catch(error){setError(messageFor(error));}finally{setBusy(false);}}
  return <main id="main" className="auth-page"><div className="auth-heading"><p className="eyebrow">A fresh start</p><h1>Reset your password.</h1><p>We’ll help you get back to your business.</p></div><div className="auth-card"><Availability available={available}/><form onSubmit={event=>void submit(event)}><fieldset disabled={busy||available!==true}><label htmlFor="email">Email address<input id="email" type="email" autoComplete="email" required value={email} onChange={event=>setEmail(event.target.value)}/></label><button className="button submit">{busy?'Sending…':'Send reset link'}</button></fieldset></form>{message&&<p className="notice" role="status">{message}</p>}{error&&<p className="error" role="alert">{error}</p>}<Link className="back-link" to="/sign-in">← Back to sign in</Link></div></main>;
}
type BusinessAccount={businessName:string;email:string;subscription:'PENDING';checkoutEnabled:false;softwareAccess:false};
function Account(){
  const navigate=useNavigate();const [account,setAccount]=useState<BusinessAccount|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let current=true;api<BusinessAccount>('/api/account').then(value=>{if(current)setAccount(value);}).catch(error=>{if(!current)return;if(error.code==='SIGN_IN_REQUIRED')navigate('/sign-in',{replace:true});else setError(messageFor(error));});return()=>{current=false;};},[navigate]);
  async function logout(){setBusy(true);try{await api('/api/logout',{});navigate('/sign-in',{replace:true});}catch(error){setError(messageFor(error));}finally{setBusy(false);}}
  return <main id="main" className="account-page"><p className="eyebrow">Your business account</p><h1>{account?`Welcome, ${account.businessName}.`:'Welcome to KavaRoutes.'}</h1>{!account&&!error&&<p role="status">Loading your account…</p>}{error&&<p className="error" role="alert">{error}</p>}{account&&<><p className="account-email">{account.email}</p><section className="account-panel"><span className="status-label">Awaiting subscription</span><h2>You’re in the right place.</h2><p>Your business account is ready. Subscription purchases will be available soon. Your software workspace becomes available after your subscription and business access are activated.</p><p className="quiet-note">No payment has been collected.</p><a className="text-link" href="mailto:kavasupport@kavaroutes.com">Contact support <span aria-hidden="true">↗</span></a></section><button className="sign-out" disabled={busy} onClick={()=>void logout()}>{busy?'Signing out…':'Sign out'}</button></>}</main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><Layout/></BrowserRouter></StrictMode>);
