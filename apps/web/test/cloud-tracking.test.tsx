import {it,expect} from 'vitest';
import {render,screen} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {CloudTrackingStatus} from '../src/components/CloudTrackingStatus';
const shift='11111111-1111-4111-8111-111111111111';
it('shows actionable overdue transmission without attributing a cause',async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
 const api:any={dispatchSnapshot:async()=>({value:{resources:[{kind:'driver-shift',reference:`driver-shift:${shift}`,version:1}]}}),shiftStatus:async()=>({value:{tracking:{status:'UPDATES_OVERDUE',reason:'NO_RECENT_UPDATE_UNKNOWN_CAUSE',contactDriver:true,evaluatedAt:'2026-09-15T00:00:00Z',lastCapturedAt:'2026-09-14T23:58:00Z',lastReceivedAt:'2026-09-14T23:58:01Z',staleAfterSeconds:60}}})};
 render(<QueryClientProvider client={client}><CloudTrackingStatus api={api} day="2026-09-14" enabled/></QueryClientProvider>);
 await screen.findByText('Shift 1: Updates overdue — contact driver');expect(screen.getByRole('alert')).toHaveTextContent('Contact the driver');expect(screen.getByText('NO RECENT UPDATE UNKNOWN CAUSE')).toBeInTheDocument();client.clear();
});
it('does not blame the driver when dispatch cannot reach the backend',async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
 render(<QueryClientProvider client={client}><CloudTrackingStatus api={{dispatchSnapshot:async()=>{throw new Error('offline');}} as any} day="2026-09-14" enabled/></QueryClientProvider>);
 await screen.findByText('Dispatch connection unavailable. Tracking status cannot be verified; this does not prove a driver lost signal.');expect(screen.queryByText(/Shift 1:/)).not.toBeInTheDocument();client.clear();
});
