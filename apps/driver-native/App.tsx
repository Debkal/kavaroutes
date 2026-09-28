import './src/tracking';
import {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, AppState, Linking, Platform, SafeAreaView, StatusBar, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import WebView, {type WebViewMessageEvent, type WebViewNavigation} from 'react-native-webview';
import {flushTracking, locationProblem, notificationPermissionGranted, prepareTracking, resumeTracking, startTracking, stopTracking, trackingStatus, type Status} from './src/tracking';

const DRIVER_URL='https://driver.kavaroutes.com/driver';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN=/^dvs_[A-Za-z0-9_-]{43}$/;
type Command={requestId:string;type:'PREPARE'|'STATUS'|'STOP'|'START'|'RESUME';token?:string;organizationId?:string;driverId?:string;shiftReference?:string;shiftGeneration?:string;loginId?:string};
function safeDriverUrl(raw:string) {try {const url=new URL(raw);return url.origin==='https://driver.kavaroutes.com'&&url.pathname==='/driver';}catch{return false;}}
function safeGateUrl(raw:string) {try {const url=new URL(raw);return url.origin==='https://driver.kavaroutes.com'&&['/business-access','/business-access/logout'].includes(url.pathname);}catch{return false;}}
function mapsUrl(raw:string) {try {const url=new URL(raw);return url.protocol==='https:'&&['www.google.com','maps.google.com','maps.apple.com'].includes(url.hostname)&&url.pathname.startsWith('/maps');}catch{return false;}}
function parseCommand(raw:string):Command {
  const value:unknown=JSON.parse(raw);
  if (!value||typeof value!=='object'||Array.isArray(value)) throw new Error('INVALID_DRIVER_COMMAND');
  const command=value as Record<string,unknown>;
  if (typeof command.requestId!=='string'||!UUID.test(command.requestId)||!['PREPARE','STATUS','STOP','START','RESUME'].includes(String(command.type))) throw new Error('INVALID_DRIVER_COMMAND');
  if (command.type==='START'&&!(typeof command.token==='string'&&TOKEN.test(command.token)&&[command.organizationId,command.driverId,command.shiftReference,command.shiftGeneration].every(v=>typeof v==='string'&&UUID.test(v))&&typeof command.loginId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(command.loginId))) throw new Error('INVALID_DRIVER_BINDING');
  return command as Command;
}

export default function App() {
  const webview=useRef<WebView>(null);
  const [loadError,setLoadError]=useState(false);
  const [working,setWorking]=useState(false);
  const [trackingProblem,setTrackingProblem]=useState<Status|null>(null);
  const [notificationProblem,setNotificationProblem]=useState(false);
  const [permissionStep,setPermissionStep]=useState<'foreground'|'background'|'opening-settings'|null>(null);
  const continueBackground=useRef<(()=>void)|null>(null);
  const askBackground=useCallback(()=>new Promise<void>(resolve=>{
    continueBackground.current=resolve;
    setPermissionStep('background');
  }),[]);
  const beginBackground=useCallback(()=>{
    const proceed=continueBackground.current;
    if(!proceed)return;
    continueBackground.current=null;
    setPermissionStep('opening-settings');
    proceed();
  },[]);
  const reply=useCallback((requestId:string,status?:Status,error?:string)=>{
    const detail=JSON.stringify({requestId,...status,...(error?{error}:{})}).replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
    webview.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('kavaroutes-native-reply',{detail:${detail}})); true;`);
  },[]);
  const onMessage=useCallback(async(event:WebViewMessageEvent)=>{
    if (!safeDriverUrl(event.nativeEvent.url)) return;
    let command:Command;
    try {command=parseCommand(event.nativeEvent.data);} catch {return;}
    setWorking(true);
    if(command.type==='PREPARE')setTrackingProblem(null);
    try {
      const status=command.type==='PREPARE'?await prepareTracking(askBackground,()=>setPermissionStep('foreground')):command.type==='STATUS'?await trackingStatus():command.type==='STOP'?await stopTracking():command.type==='RESUME'?await resumeTracking():await startTracking({token:command.token!,organizationId:command.organizationId!,driverId:command.driverId!,shiftReference:command.shiftReference!,shiftGeneration:command.shiftGeneration!,loginId:command.loginId!});
      setTrackingProblem(status.issue?status:null);
      reply(command.requestId,status);
      if (command.type==='START'||command.type==='STATUS') void flushTracking();
      if(command.type==='START'&&status.state==='active')void notificationPermissionGranted(true).then(granted=>setNotificationProblem(!granted)).catch(()=>setNotificationProblem(true));
      if(command.type==='STOP')setNotificationProblem(false);
    } catch(error) {
      const message=error instanceof Error&&error.message==='DRIVER_API_ACCESS_BLOCKED'?'Driver service is unavailable. Try again when connected.':error instanceof Error?error.message:'Background location could not start.';
      if(command.type==='PREPARE'||command.type==='START'||command.type==='RESUME')void locationProblem().then(setTrackingProblem).catch(()=>{});
      reply(command.requestId,undefined,message);
    } finally {setPermissionStep(null);setWorking(false);}
  },[askBackground,reply]);
  useEffect(()=>{
    const check=()=>void trackingStatus().then(status=>{
      setTrackingProblem(status.issue?status:null);
      if(status.state==='active')void notificationPermissionGranted().then(granted=>setNotificationProblem(!granted)).catch(()=>{});
      else setNotificationProblem(false);
    }).catch(()=>{});
    const subscription=AppState.addEventListener('change',state=>{if(state==='active')check();});
    return()=>subscription.remove();
  },[]);
  const restoreLocation=useCallback(async()=>{
    setWorking(true);
    setTrackingProblem(null);
    try{
      await prepareTracking(askBackground,()=>setPermissionStep('foreground'));
      const status=await resumeTracking();
      setTrackingProblem(status.issue?status:null);
      if(!status.issue&&status.state==='active')webview.current?.reload();
    }catch{
      const problem=await locationProblem().catch(()=>null);
      setTrackingProblem(problem??{state:'delayed',message:'Could not restore tracking. Check your connection, then try again.'});
    }finally{setPermissionStep(null);setWorking(false);}
  },[askBackground]);
  const onNavigation=useCallback((request:WebViewNavigation)=>{
    if (request.url==='about:blank') return true;
    if (safeDriverUrl(request.url)||safeGateUrl(request.url)) return true;
    if (mapsUrl(request.url)) void Linking.openURL(request.url);
    return false;
  },[]);
  return <SafeAreaView style={styles.shell}>
    <StatusBar barStyle="dark-content" backgroundColor="#f5f8f5"/>
    <WebView ref={webview} source={{uri:DRIVER_URL}} originWhitelist={['https://driver.kavaroutes.com']} onShouldStartLoadWithRequest={onNavigation}
      onOpenWindow={event=>{const url=event.nativeEvent.targetUrl;if(mapsUrl(url))void Linking.openURL(url);}}
      setSupportMultipleWindows={false} onMessage={onMessage} onError={()=>setLoadError(true)} onHttpError={event=>{if(safeDriverUrl(event.nativeEvent.url)&&event.nativeEvent.statusCode>=400)setLoadError(true);}}
      onLoadEnd={()=>setWorking(false)} onLoad={()=>setLoadError(false)} javaScriptEnabled domStorageEnabled sharedCookiesEnabled thirdPartyCookiesEnabled
      style={styles.webview}/>
    {working&&permissionStep!=='background'?<View style={styles.progress}><ActivityIndicator size="small" color="#47756a"/><Text style={styles.progressText}>{permissionStep==='foreground'?'Waiting for phone location permission…':permissionStep==='opening-settings'?'Allow location all the time in phone settings…':'Preparing location…'}</Text></View>:null}
    {permissionStep==='background'?<View style={warningStyles.box} accessibilityRole="alert">
      <Text style={warningStyles.title}>Allow background location</Text>
      <Text style={warningStyles.copy}>To keep Dispatch updated while Google Maps is open or the phone is locked, choose “Allow all the time” in the next phone settings screen. Sharing stops when your shift ends.</Text>
      <View style={warningStyles.actions}><TouchableOpacity accessibilityRole="button" style={warningStyles.button} onPress={beginBackground}><Text style={warningStyles.buttonText}>Continue to location settings</Text></TouchableOpacity></View>
    </View>:null}
    {!permissionStep&&trackingProblem?.issue?<View style={warningStyles.box} accessibilityRole="alert">
      <Text style={warningStyles.title}>Location needs attention</Text><Text style={warningStyles.copy}>{trackingProblem.message}</Text>
      <View style={warningStyles.actions}><TouchableOpacity accessibilityRole="button" style={warningStyles.button} onPress={()=>void Linking.openSettings()}><Text style={warningStyles.buttonText}>Open settings</Text></TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" style={warningStyles.button} disabled={working} onPress={()=>void restoreLocation()}><Text style={warningStyles.buttonText}>Restore tracking</Text></TouchableOpacity></View>
      <Text style={warningStyles.copy}>After restoring access, retry opening assigned work if the sign-in page is still showing.</Text>
    </View>:null}
    {!permissionStep&&!trackingProblem?.issue&&notificationProblem?<View style={warningStyles.box} accessibilityRole="alert">
      <Text style={warningStyles.title}>Shift notification is hidden</Text><Text style={warningStyles.copy}>Your location service can keep running, but Android needs notification access to show its ongoing shift and GPS status in the notification bar.</Text>
      <View style={warningStyles.actions}><TouchableOpacity accessibilityRole="button" style={warningStyles.button} onPress={()=>void Linking.openSettings()}><Text style={warningStyles.buttonText}>Enable notifications</Text></TouchableOpacity></View>
    </View>:null}
    {loadError?<View style={styles.error}><Text style={styles.title}>Driver page unavailable</Text><Text style={styles.copy}>Check your connection, then try again. If a shift is active, background location may still be running.</Text><TouchableOpacity accessibilityRole="button" style={styles.button} onPress={()=>{setLoadError(false);webview.current?.reload();}}><Text style={styles.buttonText}>Retry</Text></TouchableOpacity></View>:null}
  </SafeAreaView>;
}

const styles=StyleSheet.create({shell:{flex:1,backgroundColor:'#f5f8f5',paddingTop:Platform.OS==='android'?(StatusBar.currentHeight??24)+8:0},webview:{flex:1,backgroundColor:'#f5f8f5'},progress:{position:'absolute',top:10,alignSelf:'center',flexDirection:'row',gap:8,alignItems:'center',paddingHorizontal:14,paddingVertical:8,borderRadius:18,backgroundColor:'#fff',elevation:3},progressText:{color:'#35564e',fontSize:13},error:{position:'absolute',top:0,right:0,bottom:0,left:0,justifyContent:'center',padding:30,backgroundColor:'#f5f8f5'},title:{fontSize:25,fontWeight:'700',color:'#24473f',marginBottom:12},copy:{fontSize:16,lineHeight:23,color:'#42564f',marginBottom:24},button:{backgroundColor:'#47756a',paddingVertical:14,borderRadius:10,alignItems:'center'},buttonText:{color:'#fff',fontWeight:'700',fontSize:16}});
const warningStyles=StyleSheet.create({box:{position:'absolute',right:10,bottom:10,left:10,padding:15,borderRadius:12,backgroundColor:'#fff8e8',borderWidth:1,borderColor:'#bf8a45',elevation:5},title:{fontSize:16,fontWeight:'700',color:'#503b1d'},copy:{fontSize:14,lineHeight:19,color:'#503b1d',marginTop:5},actions:{flexDirection:'row',gap:10,marginTop:10},button:{backgroundColor:'#47756a',paddingHorizontal:12,paddingVertical:10,borderRadius:8},buttonText:{color:'#fff',fontWeight:'700'}});
