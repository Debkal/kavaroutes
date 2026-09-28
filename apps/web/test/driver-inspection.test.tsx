import {expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {DriverInspectionForm,DRIVER_INSPECTION_ITEMS} from '../src/components/DriverInspectionForm';

it('preselects no issue for a clear pre-trip vehicle check',async()=>{
  const onSubmit=vi.fn(async()=>{});
  const shift={shiftGeneration:'11111111-1111-4111-8111-111111111111',resourceVersion:1,
    effectivePolicy:{canonicalDigest:'a'.repeat(64),preInspection:{mode:'REQUIRED'},startOdometer:{mode:'DISABLED'}}};
  render(<DriverInspectionForm stage="pre" shift={shift as any} vehicleId="22222222-2222-4222-8222-222222222222" busy={false} onSubmit={onSubmit}/>);
  expect(screen.getByText(`${DRIVER_INSPECTION_ITEMS.length} of ${DRIVER_INSPECTION_ITEMS.length} items reviewed`)).toBeInTheDocument();
  expect(screen.getAllByLabelText('No issue').every(radio=>(radio as HTMLInputElement).checked)).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Submit pre-trip check'}));
  await waitFor(()=>expect(onSubmit).toHaveBeenCalledTimes(1));
  expect(onSubmit.mock.calls[0]![0].inspection.entries).toHaveLength(DRIVER_INSPECTION_ITEMS.length);
});

it('requires manual answers when Command control leaves the precheck empty',async()=>{
  const onSubmit=vi.fn(async()=>{});
  const shift={shiftGeneration:'11111111-1111-4111-8111-111111111111',resourceVersion:1,
    effectivePolicy:{canonicalDigest:'a'.repeat(64),preInspection:{mode:'REQUIRED'},startOdometer:{mode:'DISABLED'}}};
  render(<DriverInspectionForm stage="pre" precheckDefault="MANUAL" shift={shift as any} vehicleId="22222222-2222-4222-8222-222222222222" busy={false} onSubmit={onSubmit}/>);
  expect(screen.getByText(`0 of ${DRIVER_INSPECTION_ITEMS.length} items reviewed`)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Submit pre-trip check'}));
  expect(await screen.findByText(/Review this item before submitting/)).toBeInTheDocument();
  expect(onSubmit).not.toHaveBeenCalled();
});
