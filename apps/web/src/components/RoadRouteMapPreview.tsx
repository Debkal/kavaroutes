export function RoadRouteMapPreview({imageUrl,alt}:{imageUrl:string|null;alt:string}){
  return <div className="road-route-map">
    {imageUrl?<img src={imageUrl} alt={alt}/>:<p>Map preview unavailable.</p>}
    <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Powered by Geoapify</a>
  </div>;
}
