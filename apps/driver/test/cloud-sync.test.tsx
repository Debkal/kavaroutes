import {render,fireEvent,waitFor} from '@testing-library/react-native';
import SyncScreen from '../app/sync';
import {manualSyntheticSync} from '../src/nativeActions';
const mockUseWorkflow=jest.fn();
jest.mock('../src/workflow-context',()=>({useWorkflow:()=>mockUseWorkflow()}));
jest.mock('../src/nativeActions',()=>({manualSyntheticSync:jest.fn()}));
beforeEach(()=>jest.clearAllMocks());
test('cloud sync invokes server recovery, never fake acceptance or conflict controls',async()=>{
 const recoverUpdates=jest.fn(async()=>({outcome:'synchronized',detail:'Server receipts checked.'})),dispatch=jest.fn();
 mockUseWorkflow.mockReturnValue({state:{phase:'ITINERARY_ACTIVE'},cloudPrototype:true,recoverUpdates,dispatch});
 const screen=await render(<SyncScreen/>);
 expect(screen.queryByRole('button',{name:'Send to synthetic server'})).toBeNull();
 expect(screen.queryByRole('button',{name:'Test a server version conflict'})).toBeNull();
 await fireEvent.press(screen.getByRole('button',{name:'Recover private backend updates'}));
 await waitFor(()=>expect(recoverUpdates).toHaveBeenCalledWith('reconnect'));
 expect(screen.getByText(/Server receipts checked/)).toBeTruthy();expect(manualSyntheticSync).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
});
test('offline cloud sync preserves requests without exposing raw errors or fake success',async()=>{
 mockUseWorkflow.mockReturnValue({state:{phase:'ITINERARY_ACTIVE'},cloudPrototype:true,recoverUpdates:jest.fn(async()=>{throw new Error('RAW_SECRET_CANARY');})});
 const screen=await render(<SyncScreen/>);await fireEvent.press(screen.getByRole('button',{name:'Recover private backend updates'}));
 await waitFor(()=>expect(screen.getByText('Recovery unavailable')).toBeTruthy());expect(screen.queryByText('RAW_SECRET_CANARY')).toBeNull();expect(manualSyntheticSync).not.toHaveBeenCalled();
});
