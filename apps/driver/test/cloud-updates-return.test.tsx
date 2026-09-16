import { fireEvent, render, waitFor } from '@testing-library/react-native';
import UpdatesScreen from '../app/updates';
import ReturnScreen from '../app/return';
import { openSyntheticNavigation, evaluateReturnLocation } from '../src/nativeActions';
const mockUseWorkflow = jest.fn();
jest.mock('../src/workflow-context', () => ({ useWorkflow: () => mockUseWorkflow() }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock('../src/nativeActions', () => ({ openSyntheticNavigation: jest.fn(), evaluateReturnLocation: jest.fn() }));
jest.mock('../src/notification-actions', () => ({
  readNotificationPermission: jest.fn(async () => 'not_requested'),
  requestNotificationPermissionInContext: jest.fn(async () => 'granted'),
}));
beforeEach(() => jest.clearAllMocks());
test('failed sign-off stays visible without calling GPS or reporting success', async () => {
  const dispatch = jest.fn(async () => { throw new Error('RAW_SECRET_CANARY'); });
  mockUseWorkflow.mockReturnValue({ cloudPrototype: true, dispatch,
    state: { phase: 'SIGNOFF_PENDING', effectivePolicy: { returnVerification: { mode: 'DISABLED' } } } });
  const screen = await render(<ReturnScreen />);
  await fireEvent.press(screen.getByRole('button', { name: 'Sign off without return sample' }));
  await waitFor(() => expect(screen.getByText('No success confirmed')).toBeTruthy());
  expect(screen.queryByText('RAW_SECRET_CANARY')).toBeNull();
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledWith({ type: 'SIGN_OFF', location: 'UNAVAILABLE', override: false });
  expect(evaluateReturnLocation).not.toHaveBeenCalled();
});
test('failed return recovery is visible and does not submit another sign-off', async () => {
  const dispatch = jest.fn(), syncCloudFinish = jest.fn(async () => { throw new Error('RAW_SECRET_CANARY'); });
  mockUseWorkflow.mockReturnValue({ cloudPrototype: true, dispatch, syncCloudFinish,
    state: { phase: 'RETURN_LOCATION_EXCEPTION', effectivePolicy: { returnVerification: { mode: 'REQUIRED_WITH_AUDITED_OVERRIDE' } } } });
  const screen = await render(<ReturnScreen />);
  await fireEvent.press(screen.getByRole('button', { name: 'Recover server sign-off status' }));
  await waitFor(() => expect(screen.getByText('No success confirmed')).toBeTruthy());
  expect(screen.getByText('Waiting for authorized dispatch')).toBeTruthy();
  expect(dispatch).not.toHaveBeenCalled();
  expect(syncCloudFinish).toHaveBeenCalledTimes(1);
});
test('failed manual recovery is visible and never exposes transport details', async () => {
  const recoverUpdates = jest.fn(async () => { throw new Error('RAW_SECRET_CANARY'); });
  mockUseWorkflow.mockReturnValue({ recoverUpdates });
  const screen = await render(<UpdatesScreen />);
  await fireEvent.press(screen.getByRole('button', { name: 'Check for updates now' }));
  await waitFor(() => expect(screen.getByText(/Recovery unavailable. Original queued requests/)).toBeTruthy());
  expect(screen.queryByText('RAW_SECRET_CANARY')).toBeNull();
  expect(recoverUpdates).toHaveBeenCalledTimes(1);
  expect(recoverUpdates).toHaveBeenCalledWith('foreground');
});
test('notification permission does not claim provider activation', async () => {
  mockUseWorkflow.mockReturnValue({ recoverUpdates: jest.fn() });
  const screen = await render(<UpdatesScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Allow generic update notices' })).toBeTruthy());
  await fireEvent.press(screen.getByRole('button', { name: 'Allow generic update notices' }));
  await waitFor(() => expect(screen.getByText(/no active external push provider/)).toBeTruthy());
});
test('cloud return never substitutes a demo pickup as the authorized return destination', async () => {
  const dispatch = jest.fn(async () => ({ phase: 'SIGNOFF_PENDING' }));
  mockUseWorkflow.mockReturnValue({ cloudPrototype: true, state: { phase: 'READY' }, dispatch });
  const screen = await render(<ReturnScreen />);
  expect(screen.getByText('Not configured')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /directions/i })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Vehicle returned and parked' }));
  expect(dispatch).toHaveBeenCalledWith({ type: 'BEGIN_RETURN' });
  expect(openSyntheticNavigation).not.toHaveBeenCalled();
  expect(evaluateReturnLocation).not.toHaveBeenCalled();
});
