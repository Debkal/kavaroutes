import {DispatchDriverTracking} from './DispatchDriverTracking';
import type {createCloudApi} from '../cloud-api';
type Api=ReturnType<typeof createCloudApi>;

/** The dispatch view of the drivers: live tracking, the shift each covers and the
 * reviewer control that closes it, in one panel per driver. */
export function CloudTrackingStatus({api,day,enabled}:{api:Api;day:string;enabled:boolean}){
  return <section aria-label="Driver tracking">
    <DispatchDriverTracking api={api} day={day} enabled={enabled}/>
  </section>;
}
