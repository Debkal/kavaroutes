import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { CloudRouteProposalScreen } from '../src/components/CloudRouteProposalScreen';
const mockUseWorkflow = jest.fn(), mockGet = jest.fn(), mockSubmit = jest.fn();
const mockStore = { draft: jest.fn(), commands: jest.fn(), save: jest.fn(), prepare: jest.fn(), record: jest.fn() };
jest.mock('../src/workflow-context', () => ({ useWorkflow: () => mockUseWorkflow() }));
jest.mock('../src/cloud-server', () => ({ createCloudDriverApi: () => ({ getRouteProposals: mockGet, submitRouteProposal: mockSubmit }) }));
jest.mock('../src/nativeActions', () => ({ openCloudRouteStore: async () => mockStore }));
const view = { shiftId: 'shift-test', shiftGeneration: 'generation-test', policyDigest: 'policy-test',
  runVersion: 3, factsVersion: 2, mode: 'DISPATCH_APPROVAL_REQUIRED',
  nodes: [{ nodeId: 'pickup', kind: 'PICKUP', locked: false }, { nodeId: 'dropoff', kind: 'DROPOFF', locked: false }], proposals: [] };
const workflow = () => ({ state: { shiftReference: view.shiftId, shiftGeneration: view.shiftGeneration, moving: false,
  effectivePolicy: { canonicalDigest: view.policyDigest } }, syncCloudActions: jest.fn(async () => undefined) });
beforeEach(() => {
  jest.clearAllMocks(); mockStore.draft.mockResolvedValue(null); mockStore.commands.mockResolvedValue([]);
  mockStore.save.mockResolvedValue(undefined); mockStore.record.mockResolvedValue(undefined);
  mockGet.mockResolvedValue({ value: view }); mockUseWorkflow.mockReturnValue(workflow());
});
test('disabled route policy removes editing authority without hiding server state', async () => {
  mockGet.mockResolvedValue({ value: { ...view, mode: 'DISABLED' } });
  const screen = await render(<CloudRouteProposalScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Submit route proposal' })).toBeDisabled());
  expect(screen.getByRole('button', { name: 'Move stop 1 later' })).toBeDisabled();
  expect(mockSubmit).not.toHaveBeenCalled();
});
test('reopened pending proposal uses its original request and key without implying approval', async () => {
  const original = { state: 'PENDING', command_key: 'original-key', request: { proposalId: 'original-proposal', nodeOrder: ['pickup', 'dropoff'] } };
  mockStore.commands.mockResolvedValue([original]); mockStore.prepare.mockResolvedValue(original);
  mockSubmit.mockRejectedValue(new Error('RAW_SECRET_CANARY'));
  const screen = await render(<CloudRouteProposalScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Recover original proposal' })).toBeTruthy());
  expect(screen.getByRole('button', { name: 'Move stop 1 later' })).toBeDisabled();
  await fireEvent.press(screen.getByRole('button', { name: 'Recover original proposal' }));
  await waitFor(() => expect(screen.getByText(/No acceptance confirmed/)).toBeTruthy());
  expect(mockSubmit).toHaveBeenCalledWith(view.shiftId, original.request, original.command_key);
  expect(mockSubmit).toHaveBeenCalledTimes(1); expect(mockStore.record).not.toHaveBeenCalled();
  expect(screen.queryByText('RAW_SECRET_CANARY')).toBeNull();
});
test('accepted proposal receipt can remain pending dispatcher approval', async () => {
  const original = { state: 'PENDING', command_key: 'original-key', request: { proposalId: 'original-proposal' } };
  const receipt = { proposalId: 'original-proposal', state: 'PENDING_DISPATCH_APPROVAL' };
  mockStore.prepare.mockResolvedValue(original); mockSubmit.mockResolvedValue({ value: receipt });
  const w = workflow(); mockUseWorkflow.mockReturnValue(w);
  const screen = await render(<CloudRouteProposalScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Submit route proposal' })).toBeTruthy());
  await fireEvent.press(screen.getByRole('button', { name: 'Submit route proposal' }));
  await waitFor(() => expect(screen.getByText(/Server decision: PENDING DISPATCH APPROVAL/)).toBeTruthy());
  expect(mockStore.record).toHaveBeenCalledWith(original, receipt);
  expect(w.syncCloudActions).toHaveBeenCalledTimes(1);
});
