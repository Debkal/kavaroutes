import {fireEvent,render,waitFor} from "@testing-library/react-native";
import {CloudSignatureScreen} from "../src/components/CloudSignatureScreen";
const mockWorkflow=jest.fn(),mockDraft=jest.fn(),mockSave=jest.fn(async()=>undefined),mockCommands=jest.fn(async()=>[]);
jest.mock("../src/workflow-context",()=>({useWorkflow:()=>mockWorkflow()}));
jest.mock("../src/nativeActions",()=>({openCloudSignatureStore:async()=>({draft:mockDraft,saveDraft:mockSave,commands:mockCommands})}));
jest.mock("../src/crypto",()=>({createEvidenceDigest:async()=>"a".repeat(64)}));
jest.mock("expo-crypto",()=>({randomUUID:()=>"60000000-0000-4000-8000-000000000001"}));
const mockReplace=jest.fn();jest.mock("expo-router",()=>({useRouter:()=>({replace:mockReplace})}));
const points:Array<[number,number]>=Array.from({length:12},(_,i)=>[10+i*8,10+i*4]);
const proof={version:1,digest:"b".repeat(64),rule:{allowedRoles:["RIDER","RIDER_UNABLE_TO_SIGN"],unableReasons:["PHYSICALLY_UNABLE"]}};
const leg={tripLegId:"assigned-leg",assignmentId:"assignment",riderLabel:"Only this synthetic rider",execution:{lifecycle:"ARRIVED_PICKUP",expectedTag:'"server-tag"',serviceControl:{riderVerified:true,boardingSecure:true,pickupEvidenceId:null,incidentOpen:false,proofRule:proof}}};
const submit=jest.fn(async()=>undefined);
beforeEach(()=>{jest.clearAllMocks();mockCommands.mockResolvedValue([]);mockDraft.mockResolvedValue({points,role:"RIDER",unableReason:"PHYSICALLY_UNABLE",witness:"",policyDigest:proof.digest});mockWorkflow.mockReturnValue({state:{moving:false,phase:"READY",shiftReference:"actual-shift",shiftGeneration:"actual-generation",effectivePolicy:{assignmentId:"assignment",commercialTier:"SMALL_BUSINESS"}},itinerary:{legs:[leg]},cloudSignature:submit,syncCloudActions:jest.fn(async()=>undefined)});});
test("actual signature surface restores protected drawing and submits assigned shift/leg/event with explicit proof policy",async()=>{
 const screen=await render(<CloudSignatureScreen legId="assigned-leg" event="PICKUP_ATTESTATION"/>);
 await waitFor(()=>expect(screen.getByRole("button",{name:"Save signature for server acceptance"})).toBeEnabled());
 expect(screen.getByText("Only this synthetic rider")).toBeTruthy();expect(screen.queryByText("DRIVER")).toBeNull();
 await fireEvent.press(screen.getByRole("button",{name:"Save signature for server acceptance"}));
 await waitFor(()=>expect(submit).toHaveBeenCalledWith("assigned-leg",expect.objectContaining({shiftGeneration:"actual-generation",event:"PICKUP_ATTESTATION",points,expectedTag:'"server-tag"',policyDigest:proof.digest})));
});
test("empty mark cannot submit; finger events persist a replacement drawing",async()=>{
 mockDraft.mockResolvedValue(null);const screen=await render(<CloudSignatureScreen legId="assigned-leg" event="PICKUP_ATTESTATION"/>);
 await waitFor(()=>expect(screen.getByRole("button",{name:"Save signature for server acceptance"})).toBeEnabled());
 await fireEvent.press(screen.getByRole("button",{name:"Save signature for server acceptance"}));expect(submit).not.toHaveBeenCalled();
 const canvas=screen.getByLabelText("Signature drawing area");
 for(const [index,[x,y]]of points.entries())await fireEvent(canvas,"responderMove",{nativeEvent:{locationX:x,locationY:y},touchHistory:{touchBank:[{touchActive:true,currentPageX:x,currentPageY:y,previousPageX:x-1,previousPageY:y-1,currentTimeStamp:index+1}],numberActiveTouches:1,indexOfSingleActiveTouch:0,mostRecentTimeStamp:index+1}});
 await waitFor(()=>expect(mockSave).toHaveBeenCalled());
});
test("unknown response recovers original saved command and cannot replace its identity",async()=>{
 const request:any={evidenceId:"original-evidence",event:"PICKUP_ATTESTATION",points};mockCommands.mockResolvedValue([{state:"PENDING",leg:"assigned-leg",request}] as never[]);
 const screen=await render(<CloudSignatureScreen legId="assigned-leg" event="PICKUP_ATTESTATION"/>);await waitFor(()=>expect(screen.getByRole("button",{name:"Save signature for server acceptance"})).toBeEnabled());
 await fireEvent.press(screen.getByRole("button",{name:"Save signature for server acceptance"}));await waitFor(()=>expect(submit).toHaveBeenCalledWith("assigned-leg",request));
});
test("moving or unrelated rider cannot open the signature surface",async()=>{
 const screen=await render(<CloudSignatureScreen legId="unassigned" event="PICKUP_ATTESTATION"/>);expect(screen.queryByLabelText("Signature drawing area")).toBeNull();expect(screen.queryByText(leg.riderLabel)).toBeNull();
});
