import {render,fireEvent,waitFor} from '@testing-library/react-native';
import DiagnosticsScreen from '../app/diagnostics';
import {readCloudDiagnostics} from '../src/cloud-diagnostics';
import {readSafeCloudDiagnostics,readSafeDiagnostics} from '../src/nativeActions';
const mockUseWorkflow=jest.fn();
jest.mock('../src/workflow-context',()=>({useWorkflow:()=>mockUseWorkflow()}));
jest.mock('expo-router',()=>({useRouter:()=>({replace:jest.fn()})}));
jest.mock('../src/nativeActions',()=>({readSafeCloudDiagnostics:jest.fn(),readSafeDiagnostics:jest.fn()}));
const shift='929efc93-2ca6-4548-bafc-6ae3a98a89d8';
beforeEach(()=>{jest.clearAllMocks();mockUseWorkflow.mockReturnValue({cloudPrototype:true,reset:jest.fn(),state:{phase:'SHIFT_ENDED',shiftReference:shift,lastReceipt:'Server accepted sign-off.'}});});
test('cloud diagnostics shows scoped receipt counts without GPS or destructive reset',async()=>{
 jest.mocked(readSafeCloudDiagnostics).mockResolvedValue({pending:2,accepted:24,rejected:1});
 const screen=await render(<DiagnosticsScreen/>);
 expect(screen.getByText('Mode: Private backend prototype')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Reset all synthetic test data'})).toBeNull();
 await fireEvent.press(screen.getByRole('button',{name:'Refresh app details'}));
 await waitFor(()=>expect(readSafeCloudDiagnostics).toHaveBeenCalledWith(shift));
 expect(screen.getByText(/2 pending, 24 receipted, 1 rejected/)).toBeTruthy();
 expect(readSafeDiagnostics).not.toHaveBeenCalled();
});
test('diagnostic failures do not display raw adapter errors',async()=>{
 jest.mocked(readSafeCloudDiagnostics).mockRejectedValue(new Error('SENSITIVE_ERROR_CANARY'));
 const screen=await render(<DiagnosticsScreen/>);await fireEvent.press(screen.getByRole('button',{name:'Refresh app details'}));
 await waitFor(()=>expect(screen.getByText("Couldn't load app details. No queue was changed.")).toBeTruthy());
 expect(screen.queryByText('SENSITIVE_ERROR_CANARY')).toBeNull();
});
test('local-only diagnostics keeps the existing local path',async()=>{
 mockUseWorkflow.mockReturnValue({cloudPrototype:false,reset:jest.fn(),state:{phase:'SIGNED_OUT',lastReceipt:''}});
 jest.mocked(readSafeDiagnostics).mockResolvedValue({actions:1,locations:2,evidence:3,tracking:false});
 const screen=await render(<DiagnosticsScreen/>);await fireEvent.press(screen.getByRole('button',{name:'Refresh app details'}));
 await waitFor(()=>expect(screen.getByText(/1 arrival, 2 location samples, and 3 saved drafts/)).toBeTruthy());
 expect(readSafeCloudDiagnostics).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Reset all synthetic test data'})).toBeTruthy();
});
test('count reader selects only states/counts for the exact shift across all six ledgers',async()=>{
 const getAllAsync=jest.fn(async()=>[{state:'PENDING',total:2},{state:'ACCEPTED',total:24},{state:'REJECTED',total:1}]);
 expect(await readCloudDiagnostics({getAllAsync} as any,shift)).toEqual({pending:2,accepted:24,rejected:1});
 const [sql,...parameters]=getAllAsync.mock.calls[0] as unknown as [string,...string[]];
 expect(parameters).toEqual(Array(6).fill(shift));expect(sql).not.toMatch(/encrypted|SELECT \*/);
 await expect(readCloudDiagnostics({getAllAsync} as any,'invalid')).rejects.toThrow('DIAGNOSTIC_SCOPE_INVALID');
 expect(await readCloudDiagnostics({getAllAsync} as any)).toEqual({pending:0,accepted:0,rejected:0});
 expect(getAllAsync).toHaveBeenCalledTimes(1);
});
