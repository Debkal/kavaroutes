import {DispatchDriverTracking} from './DispatchDriverTracking';
import type {createCloudApi} from '../cloud-api';
type Api=ReturnType<typeof createCloudApi>;

/** The tracking workspace: live positions and shift review for the selected day. */
export function CloudTrackingStatus({api,day,enabled}:{api:Api;day:string;enabled:boolean}){
  return <section aria-label="Driver tracking">
    <DispatchDriverTracking api={api} day={day} enabled={enabled}/>
  </section>;
}
