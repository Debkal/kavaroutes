import {expect,it,vi} from "vitest";
import {render,screen,waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {businessToday,shiftServiceDay} from "../src/business-time";
import {ServiceDatePicker} from "../src/components/ServiceDatePicker";
import {ClientIntakeForm} from "../src/components/ClientIntakeForm";
import type {createCloudClientApi} from "../src/cloud-client-api";

it("uses the business day at UTC midnight and moves calendar days across DST and year boundaries",()=>{
  expect(businessToday(new Date("2026-09-17T00:30:00Z"))).toBe("2026-09-16");
  expect(shiftServiceDay("2026-03-08",1)).toBe("2026-03-09");
  expect(shiftServiceDay("2026-12-31",1)).toBe("2027-01-01");
});

it("offers quick date changes and disables navigation while a command is pending",async()=>{
  const change=vi.fn(); const user=userEvent.setup();
  const view=render(<ServiceDatePicker value="2026-12-31" onChange={change}/>);
  await user.click(screen.getByRole("button",{name:"Next day"}));
  expect(change).toHaveBeenLastCalledWith("2027-01-01");
  await user.click(screen.getByRole("button",{name:"Today",exact:true}));
  expect(change).toHaveBeenLastCalledWith(businessToday());
  view.rerender(<ServiceDatePicker value="2026-12-31" onChange={change} disabled/>);
  expect(screen.getByRole("button",{name:"Tomorrow"})).toBeDisabled();
});

it("saves a client's home without requiring or manufacturing a trip destination",async()=>{
  const create=vi.fn(async()=>({value:{clientId:"10000000-0000-4000-8000-000000000001",displayName:"Synthetic Alex",version:1,dropoffCount:0}}));
  render(<ClientIntakeForm api={{create} as unknown as ReturnType<typeof createCloudClientApi>}/>);
  const user=userEvent.setup();
  await user.type(screen.getByLabelText("Client name"),"Synthetic Alex");
  await user.click(screen.getByRole("button",{name:"Add client",exact:true}));
  expect(create).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText("Home / usual pickup address"),"100 Synthetic Home Street");
  await user.click(screen.getByRole("button",{name:"Add client",exact:true}));
  await waitFor(()=>expect(create).toHaveBeenCalledOnce());
  expect(create.mock.calls[0]?.[0]).toEqual({displayName:"Synthetic Alex",entityName:null,phone:null,pickupAddress:"100 Synthetic Home Street",notes:null});
  expect(screen.queryByLabelText(/Drop-off address/)).not.toBeInTheDocument();
});
