import {QueryClientProvider} from '@tanstack/react-query';
import {createBrowserRouter,Link,Outlet,redirect,useRouteError} from 'react-router';
import {queryClient} from './runtime';

declare const __KR_WEB_BUILD__:string;
const build=typeof __KR_WEB_BUILD__==='string'?__KR_WEB_BUILD__:'unknown';
function Shell(){return <QueryClientProvider client={queryClient}>
  <a className="skip-link" href="#main-content">Skip to main content</a>
  <header className="app-header driver-app-header"><div><span className="brand-mark" aria-hidden="true">KR</span><strong>KavaRoutes Driver</strong></div></header>
  <Outlet/>
  <footer className="app-footer"><span>Driver web build {build}</span></footer>
</QueryClientProvider>;}
function ErrorView(){const error=useRouteError();return <main id="main-content" className="message-page"><h1>We could not open Driver</h1><p role="alert">{error instanceof Error?error.message:'Unexpected error'}</p><Link to="/driver">Return to Driver</Link></main>;}
function Loading(){return <main id="main-content" className="message-page"><p role="status">Loading Driver…</p></main>;}
export const driverRouter=createBrowserRouter([{path:'/',element:<Shell/>,errorElement:<ErrorView/>,HydrateFallback:Loading,children:[
  {index:true,loader:()=>redirect('/driver')},
  {path:'driver',lazy:()=>import('./routes/cloud-driver-route')},
  {path:'driver-admin',lazy:()=>import('./routes/driver-admin-route')},
  {path:'*',element:<main id="main-content" className="message-page"><h1>Page not found</h1><Link to="/driver">Open Driver</Link></main>},
]}]);
