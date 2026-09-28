const DRIVER_ORIGIN='https://driver.kavaroutes.com';

export function driverOrigin(raw:string):boolean {
  try{return new URL(raw).origin===DRIVER_ORIGIN;}
  catch{return false;}
}

export function driverPage(raw:string):boolean {
  try {const url=new URL(raw);return driverOrigin(raw)&&url.pathname==='/driver';}
  catch{return false;}
}

/** Android WebViewCompat supplies sourceOrigin, not the page path, in onMessage.
 * Validate that origin and the independently observed top-level page. */
export function driverMessageAllowed(sourceUrl:string,loadedPageUrl:string|null):boolean {
  if(!loadedPageUrl||!driverPage(loadedPageUrl))return false;
  return driverOrigin(sourceUrl);
}
