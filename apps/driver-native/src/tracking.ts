import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import {getRandomBytes, randomUUID} from 'expo-crypto';
import {openDatabaseAsync, type SQLiteDatabase} from 'expo-sqlite';
import {PermissionsAndroid,Platform} from 'react-native';

const TASK = 'kavaroutes.driver.location';
const ORIGIN = 'https://driver.kavaroutes.com';
const KEY = 'driver.location.database.key';
const BINDING = 'driver.location.shift.binding';
const STORE_OPTIONS = {keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^dvs_[A-Za-z0-9_-]{43}$/;

export type Status = {state:'idle'|'starting'|'active'|'delayed'|'stopped'; message:string;issue?:'FOREGROUND_PERMISSION'|'BACKGROUND_PERMISSION'|'LOCATION_SERVICES'|'BACKGROUND_TASK'};
export type Binding = {token:string; organizationId:string; driverId:string; shiftReference:string; shiftGeneration:string; deviceId:string;loginId?:string};
type Sample = {sample_id:string; sequence:number; captured_at:string; latitude:number; longitude:number; accuracy_meters:number|null; batch_ref:string|null};
let dbPromise:Promise<SQLiteDatabase>|null=null;
let uploadPromise:Promise<Status>|null=null;

function hex(bytes:Uint8Array) {return [...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
async function database() {
  dbPromise ??= (async()=>{
    let key = await SecureStore.getItemAsync(KEY,STORE_OPTIONS);
    if (!key) {key=hex(getRandomBytes(32)); await SecureStore.setItemAsync(KEY,key,STORE_OPTIONS);}
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('LOCATION_STORAGE_UNAVAILABLE');
    const db=await openDatabaseAsync('driver-location.sqlite',{useNewConnection:true});
    await db.execAsync(`PRAGMA key = "x'${key}'"`);
    const cipher=await db.getFirstAsync<{cipher_version:string}>('PRAGMA cipher_version');
    if (!cipher?.cipher_version) throw new Error('LOCATION_STORAGE_UNAVAILABLE');
    await db.execAsync('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS samples (sequence INTEGER PRIMARY KEY AUTOINCREMENT, sample_id TEXT NOT NULL UNIQUE, captured_at TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, accuracy_meters REAL, batch_ref TEXT); CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), device_id TEXT NOT NULL, last_upload_at INTEGER NOT NULL DEFAULT 0);');
    return db;
  })();
  try {return await dbPromise;} catch(error) {dbPromise=null;throw error;}
}
function validBinding(value:unknown):value is Binding {
  if (!value||typeof value!=='object') return false;
  const b=value as Record<string,unknown>;
  return typeof b.token==='string'&&TOKEN.test(b.token)&&[b.organizationId,b.driverId,b.shiftReference,b.shiftGeneration,b.deviceId].every(v=>typeof v==='string'&&UUID.test(v))&&(b.loginId===undefined||(typeof b.loginId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(b.loginId)));
}
async function readBinding():Promise<Binding|null> {
  const raw=await SecureStore.getItemAsync(BINDING,STORE_OPTIONS);
  if (!raw) return null;
  try {const value:unknown=JSON.parse(raw);return validBinding(value)?value:null;} catch {return null;}
}
function url(binding:Binding,path:string) {return `${ORIGIN}/v1/organizations/${binding.organizationId}/driver/shifts/${binding.shiftReference}/${path}`;}
async function headers(binding:Binding) {
  return {authorization:`DriverSession ${binding.token}`,accept:'application/json'};
}
async function responseJson(response:Response):Promise<Record<string,unknown>> {
  if (!response.headers.get('content-type')?.includes('application/json')||(response.url&&new URL(response.url).origin!==ORIGIN)) throw new Error('DRIVER_API_ACCESS_BLOCKED');
  const value:unknown=await response.json();
  if (!value||typeof value!=='object'||Array.isArray(value)) throw new Error('LOCATION_SERVER_RESPONSE_INVALID');
  return value as Record<string,unknown>;
}
async function serverShiftIsActive(binding:Binding):Promise<boolean> {
  const response=await fetch(url(binding,'status'),{headers:await headers(binding),credentials:'omit',cache:'no-store',redirect:'error'});
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('DRIVER_API_ACCESS_BLOCKED');
  if (!response.ok) throw new Error(response.status===401?'DRIVER_SESSION_EXPIRED':`SHIFT_STATUS_HTTP_${response.status}`);
  const body=await responseJson(response);
  if (body.shiftReference!==binding.shiftReference||body.driverId!==binding.driverId||body.shiftGeneration!==binding.shiftGeneration) throw new Error('SHIFT_IDENTITY_MISMATCH');
  return body.lifecycle==='ACTIVE'&&body.collectionStopped===false;
}

export async function prepareTracking(onBackgroundPermissionNeeded?:()=>Promise<void>,onForegroundPermissionNeeded?:()=>void):Promise<Status> {
  // Notification permission is optional for this service. Never block shift
  // sign-in behind it or request it ahead of the required location permission.
  if (!(await Location.hasServicesEnabledAsync())) throw new Error('Turn on phone location services to start a Driver shift.');
  onForegroundPermissionNeeded?.();
  const foreground=await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) throw new Error('Allow location to start a Driver shift.');
  let background=await Location.getBackgroundPermissionsAsync();
  if(!background.granted){
    if(onBackgroundPermissionNeeded)await onBackgroundPermissionNeeded();
    background=await Location.requestBackgroundPermissionsAsync();
  }
  if (!background.granted) throw new Error('Allow location at all times in phone settings to track while Google Maps is open.');
  if (!(await Location.hasServicesEnabledAsync())) throw new Error('Turn on phone location services to start a Driver shift.');
  await database();
  return {state:'idle',message:'Background location permission is ready.'};
}

/** Read-only check: never opens a system prompt during a shift or on app resume. */
export async function locationProblem():Promise<Status|null> {
  if(!(await Location.hasServicesEnabledAsync()))return {state:'delayed',issue:'LOCATION_SERVICES',message:'Phone location services are off. Turn on the phone Location switch to start or restore your Driver shift.'};
  if(!(await Location.getForegroundPermissionsAsync()).granted)return {state:'delayed',issue:'FOREGROUND_PERMISSION',message:'Location permission is off. Open phone settings and allow location for KavaRoutes Driver.'};
  if(!(await Location.getBackgroundPermissionsAsync()).granted)return {state:'delayed',issue:'BACKGROUND_PERMISSION',message:'Background location is off. Allow location all the time so Dispatch can track the active shift while Maps is open.'};
  return null;
}

/** Android 13+ can hide the ongoing service notification until this is allowed. */
export async function notificationPermissionGranted(request=false):Promise<boolean> {
  if(Platform.OS!=='android'||Number(Platform.Version)<33)return true;
  const permission=PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if(await PermissionsAndroid.check(permission))return true;
  return request?(await PermissionsAndroid.request(permission))===PermissionsAndroid.RESULTS.GRANTED:false;
}

async function saveLocations(locations:Location.LocationObject[]) {
  const db=await database();
  // Every statement uses the already-keyed SQLCipher connection. Expo's
  // withExclusiveTransactionAsync opens a second connection without our key.
  for (const point of locations) {
    const {latitude,longitude,accuracy}=point.coords;
    if (!Number.isFinite(latitude)||!Number.isFinite(longitude)||latitude < -90||latitude > 90||longitude < -180||longitude > 180) continue;
    await db.runAsync('INSERT INTO samples (sample_id,captured_at,latitude,longitude,accuracy_meters,batch_ref) VALUES (?,?,?,?,?,NULL)',randomUUID(),new Date(point.timestamp||Date.now()).toISOString(),latitude,longitude,Number.isFinite(accuracy)&&accuracy!==null?Math.max(0,Math.round(accuracy)):null);
  }
  // At a 15-second fix interval, 5,760 unclaimed points cover 24 hours offline.
  // Never prune a claimed batch while an upload or retry may still be pending.
  await db.runAsync('DELETE FROM samples WHERE batch_ref IS NULL AND sequence NOT IN (SELECT sequence FROM samples WHERE batch_ref IS NULL ORDER BY sequence DESC LIMIT 5760)');
}

async function claimSamples(db:SQLiteDatabase):Promise<{rows:Sample[];batchReference:string}>{
  const first=await db.getFirstAsync<{batch_ref:string|null}>('SELECT batch_ref FROM samples ORDER BY sequence LIMIT 1');
  if(!first)return {rows:[],batchReference:''};
  const batchReference=first.batch_ref??randomUUID();
  // A concurrent foreground/background uploader may claim the same rows.
  // Only unclaimed rows can change; the server deduplicates a shared batch
  // reference if both readers reach the network.
  if(!first.batch_ref)await db.runAsync('UPDATE samples SET batch_ref=? WHERE sequence IN (SELECT sequence FROM samples WHERE batch_ref IS NULL ORDER BY sequence LIMIT 60)',batchReference);
  const rows=await db.getAllAsync<Sample>('SELECT * FROM samples WHERE batch_ref=? ORDER BY sequence LIMIT 60',batchReference);
  return {rows,batchReference};
}

async function upload():Promise<Status> {
  let stage='binding';
  try {
    const binding=await readBinding();
    if (!binding) return {state:'stopped',message:'Location sharing is stopped.'};
    stage='storage';
    const db=await database();
    stage='state';
    const state=await db.getFirstAsync<{last_upload_at:number}>('SELECT last_upload_at FROM state WHERE id=1');
    if (state && Date.now()-state.last_upload_at<60_000) return {state:'active',message:'Background location is running. Dispatch receives updates about once a minute.'};
    stage='shift-check';
    if (!(await serverShiftIsActive(binding))) {await stopTracking();return {state:'stopped',message:'Shift ended; location sharing stopped.'};}
    stage='queue';
    const {rows,batchReference}=await claimSamples(db);
    if (!rows.length) return state?.last_upload_at
      ? {state:'active',message:'Background location is running. Waiting for the next GPS fix.'}
      : {state:'delayed',message:'Waiting for the first GPS fix. Turn on precise location and keep Driver open.'};
    const samples=rows.map(row=>({sampleId:row.sample_id,sequence:row.sequence,capturedAt:row.captured_at,latitude:row.latitude,longitude:row.longitude,accuracyMeters:row.accuracy_meters}));
    stage='send';
    const response=await fetch(url(binding,'location-batches'),{method:'POST',headers:{...await headers(binding),'content-type':'application/json','idempotency-key':`driver-location-${batchReference}`},credentials:'omit',redirect:'error',body:JSON.stringify({shiftGeneration:binding.shiftGeneration,batchReference,deviceId:binding.deviceId,samples})});
    if (!response.ok) throw new Error(response.status===401?'DRIVER_SESSION_EXPIRED':`LOCATION_UPLOAD_HTTP_${response.status}`);
    stage='receipt';
    const receipt=await responseJson(response);
    if (receipt.shiftReference!==binding.shiftReference||receipt.batchReference!==batchReference||!Array.isArray(receipt.items)||receipt.items.length!==rows.length||receipt.items.some((item,index)=>!item||typeof item!=='object'||item.sampleId!==rows[index]?.sample_id||!['APPLIED','REPLAYED','REJECTED'].includes(item.outcome))) throw new Error('LOCATION_RECEIPT_INVALID');
    stage='commit';
    const rejected=receipt.items.filter(item=>item.outcome==='REJECTED').length;
    await db.runAsync('DELETE FROM samples WHERE batch_ref=?',batchReference);
    await db.runAsync('UPDATE state SET last_upload_at=? WHERE id=1',Date.now());
    if(rejected)return {state:'delayed',message:`${rejected} GPS ${rejected===1?'fix was':'fixes were'} rejected by the server. Keep Driver open and contact Dispatch if this continues.`};
    return {state:'active',message:'Background location is running. Dispatch receives updates about once a minute.'};
  } catch(error) {
    const known=error instanceof Error&&/^(?:DRIVER_SESSION_EXPIRED|DRIVER_API_ACCESS_BLOCKED|SHIFT_STATUS_HTTP_\d{3}|LOCATION_UPLOAD_HTTP_\d{3}|LOCATION_RECEIPT_INVALID|LOCATION_STORAGE_UNAVAILABLE)$/.test(error.message);
    if(known)throw error;
    // Never include raw platform exceptions: they can contain request URLs or
    // database internals. A bounded stage names the failing operation instead.
    throw new Error(`LOCATION_STAGE_${stage.toUpperCase().replaceAll('-','_')}_FAILED`);
  }
}

export async function flushTracking():Promise<Status> {
  uploadPromise ??= upload().catch(error=>{
    const code=error instanceof Error?error.message:'';
    const message=code==='DRIVER_SESSION_EXPIRED'?'Driver session expired. Sign in again to resume uploads.'
      :code==='DRIVER_API_ACCESS_BLOCKED'?'Driver service is unavailable. Reopen Driver and try again.'
      :/^SHIFT_STATUS_HTTP_\d{3}$/.test(code)?`Shift status check failed (${code}). Keep Driver open and contact Dispatch.`
      :/^LOCATION_UPLOAD_HTTP_\d{3}$/.test(code)?`GPS upload was rejected (${code}). Keep Driver open and contact Dispatch.`
      :code==='LOCATION_RECEIPT_INVALID'?'GPS upload receipt was invalid. Keep Driver open and contact Dispatch.'
      :code==='LOCATION_STORAGE_UNAVAILABLE'?'Phone location storage is unavailable. Reopen Driver and contact Dispatch.'
      :/^LOCATION_STAGE_(?:BINDING|STORAGE|STATE|SHIFT_CHECK|QUEUE|SEND|RECEIPT|COMMIT)_FAILED$/.test(code)?`GPS update failed at ${code.replace('LOCATION_STAGE_','').replace('_FAILED','').replaceAll('_',' ').toLowerCase()} (${code}). Keep Driver open and contact Dispatch.`
      :'Location uploads are delayed (network or device error). Keep Driver open and contact Dispatch.';
    return {state:'delayed' as const,message};
  }).finally(()=>{uploadPromise=null;});
  return uploadPromise;
}

async function primeLocation(binding:Binding) {
  try {
    const point=await Location.getCurrentPositionAsync({accuracy:Location.Accuracy.High});
    const current=await readBinding();
    if(!current||current.shiftReference!==binding.shiftReference||current.shiftGeneration!==binding.shiftGeneration)return;
    await saveLocations([point]);
    await flushTracking();
  } catch { /* The foreground service retries with the next GPS fix. */ }
}

export async function startTracking(input:Omit<Binding,'deviceId'>):Promise<Status> {
  if (!validBinding({...input,deviceId:randomUUID()})) throw new Error('DRIVER_TRACKING_BINDING_INVALID');
  const problem=await locationProblem();
  if(problem)throw new Error(problem.message);
  if (!(await serverShiftIsActive({...input,deviceId:randomUUID()}))) throw new Error('The assigned shift is not active. Refresh Driver and try again.');
  const db=await database();
  const previous=await readBinding();
  // Expo can keep the task registered after Android kills its foreground
  // service. A fresh START/RESUME must recreate the service, not trust the
  // persisted registration alone.
  if (await Location.hasStartedLocationUpdatesAsync(TASK)) await Location.stopLocationUpdatesAsync(TASK);
  const priorState=await db.getFirstAsync<{device_id:string}>('SELECT device_id FROM state WHERE id=1');
  const deviceId=previous?.shiftReference===input.shiftReference?previous.deviceId:priorState?.device_id??randomUUID();
  if (previous?.shiftReference!==input.shiftReference) await db.runAsync('DELETE FROM samples');
  await db.runAsync('INSERT OR REPLACE INTO state (id,device_id,last_upload_at) VALUES (1,?,0)',deviceId);
  await SecureStore.setItemAsync(BINDING,JSON.stringify({...input,deviceId}),STORE_OPTIONS);
  try {await Location.startLocationUpdatesAsync(TASK,{
      accuracy:Location.Accuracy.High,
      // A minimum movement distance suppresses every fix while parked or
      // waiting. Keep fixes flowing; upload() still batches to once a minute.
      distanceInterval:0,
      timeInterval:15_000,
      deferredUpdatesInterval:60_000,
      showsBackgroundLocationIndicator:true,
      pausesUpdatesAutomatically:false,
      activityType:Location.ActivityType.AutomotiveNavigation,
      ...(Platform.OS==='android'?{foregroundService:{notificationTitle:'Driving shift active · GPS on',notificationBody:'Location tracking for Dispatch, including while Maps is open. Tap to return to Driver.',notificationColor:'#47756a',killServiceOnDestroy:false}}:{}),
    });} catch(error) {
      if(previous?.shiftReference===input.shiftReference)await SecureStore.setItemAsync(BINDING,JSON.stringify(previous),STORE_OPTIONS);
      else await SecureStore.deleteItemAsync(BINDING);
      throw error;
    }
  void primeLocation({...input,deviceId});
  return {state:'active',message:'Background location is on, including while Google Maps is open.'};
}

export async function stopTracking():Promise<Status> {
  await SecureStore.deleteItemAsync(BINDING);
  if (await Location.hasStartedLocationUpdatesAsync(TASK)) await Location.stopLocationUpdatesAsync(TASK);
  const db=await database();
  await db.runAsync('DELETE FROM samples');
  return {state:'stopped',message:'Location sharing is stopped.'};
}

export async function trackingStatus():Promise<Status> {
  const binding=await readBinding();
  if (!binding) return {state:'idle',message:'Location starts when your shift starts.'};
  const problem=await locationProblem();
  if(problem)return problem;
  const running=await Location.hasStartedLocationUpdatesAsync(TASK);
  if (!running) return {state:'delayed',issue:'BACKGROUND_TASK',message:'Background tracking stopped unexpectedly. Reopen Driver and restore tracking.'};
  return flushTracking();
}

export async function resumeTracking():Promise<Status&{token?:string;organizationId?:string;driverId?:string;loginId?:string}> {
  const binding=await readBinding();
  if(!binding)return {state:'idle',message:'Sign in with your driver account.'};
  if(!(await serverShiftIsActive(binding))){await stopTracking();return {state:'stopped',message:'The previous shift has ended. Sign in again.'};}
  const problem=await locationProblem();
  if(problem)return {...problem,token:binding.token,organizationId:binding.organizationId,driverId:binding.driverId,...(binding.loginId?{loginId:binding.loginId}:{})};
  await startTracking(binding);
  return {state:'active',message:'Active shift restored. Background location is running.',token:binding.token,organizationId:binding.organizationId,driverId:binding.driverId,...(binding.loginId?{loginId:binding.loginId}:{})};
}

TaskManager.defineTask<{locations?:Location.LocationObject[]}>(TASK,async({data,error})=>{
  if (error||!data?.locations?.length) return;
  const binding=await readBinding();
  if (!binding) return;
  try {await saveLocations(data.locations);await flushTracking();}
  catch { /* No coordinates or credentials in logs. The next fix retries the persisted batch. */ }
});
