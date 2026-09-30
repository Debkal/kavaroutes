import { render, fireEvent } from '@testing-library/react-native';
import ManifestScreen from '../app/manifest';
const mockUseWorkflow = jest.fn(), mockPush = jest.fn();
jest.mock('../src/workflow-context', () => ({ useWorkflow: () => mockUseWorkflow() }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
const leg = { tripLegId: '40000000-0000-4000-8000-000000000004', ordinal: 1,
  plannedStartAt: '2026-09-15T16:00:00Z', runLifecycle: 'scheduled', riderLabel: 'Assigned rider',
  pickupLabel: 'Assigned pickup', dropoffLabel: 'Assigned destination', vehicleLabel: 'Assigned van',
  execution: { lifecycle: 'COMPLETED' } };
beforeEach(() => jest.clearAllMocks());
test('cloud itinerary shows per-leg execution independently of run and opens the actual leg', async () => {
  mockUseWorkflow.mockReturnValue({ state: { moving: false }, cloudPrototype: true,
    itinerary: { serviceDate: '2026-09-15', legs: [leg] } });
  const screen = await render(<ManifestScreen />);
  expect(screen.getByText('COMPLETED')).toBeTruthy();
  expect(screen.getByText('Run: scheduled')).toBeTruthy();
  expect(screen.queryByText('Still being connected')).toBeNull();
  expect(screen.queryByText('Synthetic Rider A')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'View trip 1 details' }));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/stop/[reference]', params: { reference: leg.tripLegId } });
});
test('missing execution and unavailable itinerary never substitute local completion', async () => {
  mockUseWorkflow.mockReturnValue({ state: { moving: false }, cloudPrototype: true,
    itinerary: { serviceDate: '2026-09-15', legs: [{ ...leg, execution: undefined }] } });
  const screen = await render(<ManifestScreen />);
  expect(screen.getByText('Execution not available')).toBeTruthy();
  expect(screen.queryByText('COMPLETED')).toBeNull();
  mockUseWorkflow.mockReturnValue({ state: { moving: false }, cloudPrototype: true, itinerary: null });
  await screen.rerender(<ManifestScreen />);
  expect(screen.getByText('Unavailable')).toBeTruthy();
  expect(screen.queryByText('Assigned rider')).toBeNull();
  expect(screen.queryByText('Synthetic Rider A')).toBeNull();
});
