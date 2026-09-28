import L from 'leaflet';
import type {createCloudApi} from '../cloud-api';

type Api=ReturnType<typeof createCloudApi>;
const TILE_CACHE=new Map<string,string>();
let tileCacheBytes=0;

function rememberTile(key:string,imageUrl:string){
  const prior=TILE_CACHE.get(key);
  if(prior){tileCacheBytes-=prior.length;TILE_CACHE.delete(key);}
  while(TILE_CACHE.size&&(TILE_CACHE.size>=256||tileCacheBytes+imageUrl.length>16*1024*1024)){
    const oldest=TILE_CACHE.keys().next().value!;
    tileCacheBytes-=TILE_CACHE.get(oldest)!.length;TILE_CACHE.delete(oldest);
  }
  if(imageUrl.length<=16*1024*1024){TILE_CACHE.set(key,imageUrl);tileCacheBytes+=imageUrl.length;}
}

/** Both Dispatch maps pool decoded tiles and batch uncached tile requests. */
export function addAuthorizedStreetTiles(map:any,api:Api,onError:()=>void){
  const waiting=new Map<string,{coords:{z:number;x:number;y:number};listeners:{img:HTMLImageElement;done:(error:Error|null,tile:HTMLImageElement)=>void}[]}>();
  let timer:number|undefined;
  let disposed=false;
  const deliver=(key:string,imageUrl:string|null,listeners:{img:HTMLImageElement;done:(error:Error|null,tile:HTMLImageElement)=>void}[])=>{
    if(disposed)return;
    if(imageUrl)rememberTile(key,imageUrl);
    for(const {img,done} of listeners){
      if(imageUrl)img.src=imageUrl;
      else{onError();done(new Error('MAP_TILE_UNAVAILABLE'),img);}
    }
  };
  const flush=()=>{
    timer=undefined;
    const batch=[...waiting.entries()].slice(0,32);
    for(const [key] of batch)waiting.delete(key);
    if(waiting.size)timer=window.setTimeout(flush,16);
    if(!batch.length)return;
    void api.mapTiles(batch.map(([,item])=>item.coords)).then(result=>{
      batch.forEach(([key,item],index)=>deliver(key,result.value.tiles[index]?.imageUrl??null,item.listeners));
    }).catch(()=>batch.forEach(([key,item])=>deliver(key,null,item.listeners)));
  };
  const AuthorizedTiles=L.TileLayer.extend({createTile(coords:{z:number;x:number;y:number},done:(error:Error|null,tile:HTMLImageElement)=>void){
    const img=document.createElement('img');img.alt='';img.width=256;img.height=256;
    img.onload=()=>done(null,img);
    img.onerror=()=>{onError();done(new Error('MAP_TILE_UNAVAILABLE'),img);};
    const key=`${coords.z}/${coords.x}/${coords.y}`;
    const cached=TILE_CACHE.get(key);
    if(cached){rememberTile(key,cached);img.src=cached;return img;}
    const queued=waiting.get(key);
    if(queued)queued.listeners.push({img,done});
    else waiting.set(key,{coords,listeners:[{img,done}]});
    if(timer===undefined)timer=window.setTimeout(flush,16);
    return img;
  }});
  const layer=new AuthorizedTiles('',{tileSize:256,maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> · <a href="https://www.geoapify.com/">Geoapify</a>'}).addTo(map);
  return()=>{disposed=true;if(timer!==undefined)window.clearTimeout(timer);waiting.clear();map.removeLayer(layer);};
}
