import './src/tracking';
import {useCallback, useRef, useState} from 'react';
import {ActivityIndicator, Linking, SafeAreaView, StatusBar, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import WebView, {type WebViewMessageEvent, type WebViewNavigation} from 'react-native-webview';
import {flushTracking, prepareTracking, resumeTracking, startTracking, stopTracking, trackingStatus, type Status} from './src/tracking';

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
  const reply=useCallback((requestId:string,status?:Status,error?:string)=>{
    const detail=JSON.stringify({requestId,...status,...(error?{error}:{})}).replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
    webview.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('kavaroutes-native-reply',{detail:${detail}})); true;`);
  },[]);
  const onMessage=useCallback(async(event:WebViewMessageEvent)=>{
    if (!safeDriverUrl(event.nativeEvent.url)) return;
    let command:Command;
    try {command=parseCommand(event.nativeEvent.data);} catch {return;}
    setWorking(true);
    try {
      const status=command.type==='PREPARE'?await prepareTracking():command.type==='STATUS'?await trackingStatus():command.type==='STOP'?await stopTracking():command.type==='RESUME'?await resumeTracking():await startTracking({token:command.token!,organizationId:command.organizationId!,driverId:command.driverId!,shiftReference:command.shiftReference!,shiftGeneration:command.shiftGeneration!,loginId:command.loginId!});
      reply(command.requestId,status);
      if (command.type==='START'||command.type==='STATUS') void flushTracking();
    } catch(error) {
      const message=error instanceof Error&&error.message==='DRIVER_API_ACCESS_BLOCKED'?'Driver service is unavailable. Try again when connected.':error instanceof Error?error.message:'Background location could not start.';
      reply(command.requestId,undefined,message);
    } finally {setWorking(false);}
  },[reply]);
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
    {working?<View style={styles.progress}><ActivityIndicator size="small" color="#47756a"/><Text style={styles.progressText}>Preparing location…</Text></View>:null}
    {loadError?<View style={styles.error}><Text style={styles.title}>Driver page unavailable</Text><Text style={styles.copy}>Check your connection, then try again. If a shift is active, background location may still be running.</Text><TouchableOpacity accessibilityRole="button" style={styles.button} onPress={()=>{setLoadError(false);webview.current?.reload();}}><Text style={styles.buttonText}>Retry</Text></TouchableOpacity></View>:null}
  </SafeAreaView>;
}

const styles=StyleSheet.create({shell:{flex:1,backgroundColor:'#f5f8f5'},webview:{flex:1,backgroundColor:'#f5f8f5'},progress:{position:'absolute',top:10,alignSelf:'center',flexDirection:'row',gap:8,alignItems:'center',paddingHorizontal:14,paddingVertical:8,borderRadius:18,backgroundColor:'#fff',elevation:3},progressText:{color:'#35564e',fontSize:13},error:{position:'absolute',top:0,right:0,bottom:0,left:0,justifyContent:'center',padding:30,backgroundColor:'#f5f8f5'},title:{fontSize:25,fontWeight:'700',color:'#24473f',marginBottom:12},copy:{fontSize:16,lineHeight:23,color:'#42564f',marginBottom:24},button:{backgroundColor:'#47756a',paddingVertical:14,borderRadius:10,alignItems:'center'},buttonText:{color:'#fff',fontWeight:'700',fontSize:16}});
