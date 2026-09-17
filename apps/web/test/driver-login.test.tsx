import {describe,expect,it,vi} from "vitest";
import {fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router";
import type {createCloudApi} from "../src/cloud-api";
import type {createCloudDriverWebApi} from "../src/cloud-driver-api";
import {DriverLoginForm} from "../src/components/DriverLoginForm";
import {DriverLoginPanel} from "../src/components/DriverLoginPanel";

const driverId="30000000-0000-4000-8000-000000000001";

describe("driver account access",()=>{
  it("accepts a password login and hands the verified driver to the workflow",async()=>{
    const onVerified=vi.fn();
    const verifyLogin=vi.fn(async()=>({value:{driverId,loginId:"PonyDriver",status:"ACTIVE",claimedAt:"2026-09-17T00:00:00.000Z",lastLoginAt:"2026-09-17T00:00:00.000Z",version:2}}));
    render(<DriverLoginPanel api={{verifyLogin} as unknown as ReturnType<typeof createCloudDriverWebApi>} driverReference={driverId} onVerified={onVerified}/>);
    fireEvent.change(screen.getByLabelText("Login ID"),{target:{value:"PonyDriver"}});
    fireEvent.change(screen.getByLabelText("Password",{selector:"input"}),{target:{value:"correct-horse"}});
    fireEvent.click(screen.getByRole("button",{name:"Sign in and open itinerary"}));
    await waitFor(()=>expect(onVerified).toHaveBeenCalledWith(driverId,"PonyDriver"));
  });

  it("lets Command reset a selected driver and displays the replacement one-time code",async()=>{
    vi.spyOn(window,"confirm").mockReturnValue(true);
    const createDriverLogin=vi.fn(async()=>({value:{driverId,loginId:"ponydriver",inviteCode:"NEW-CODE-123",status:"INVITED",version:3}}));
    const api={board:async()=>({value:{drivers:[{id:driverId,label:"PonyDriver"}],runs:[],vehicles:[],legs:[]}}),createDriverLogin};
    const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
    render(<MemoryRouter><QueryClientProvider client={client}><DriverLoginForm api={api as unknown as ReturnType<typeof createCloudApi>} serviceDate="2026-09-17"/></QueryClientProvider></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button",{name:/PonyDriver/}));
    fireEvent.click(screen.getByRole("button",{name:"Reset password"}));
    await screen.findByText("NEW-CODE-123");
    expect(createDriverLogin).toHaveBeenCalledWith({driverId,loginId:"ponydriver"},expect.stringMatching(/^web-driver-login-/));
    client.clear();
  });

  it("adds a new fleet driver and issues the first login code in one Command action",async()=>{
    const createDriverAccount=vi.fn(async()=>({value:{driverId:"40000000-0000-4000-8000-000000000001",displayName:"River Driver",workforceRelationship:"CONTRACTOR",loginId:"river-driver",inviteCode:"FIRST-CODE-9",status:"INVITED",version:1}}));
    const api={board:async()=>({value:{drivers:[{id:driverId,label:"PonyDriver"}],runs:[],vehicles:[],legs:[]}}),createDriverAccount};
    const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
    render(<MemoryRouter><QueryClientProvider client={client}><DriverLoginForm api={api as unknown as ReturnType<typeof createCloudApi>} serviceDate="2026-09-17"/></QueryClientProvider></MemoryRouter>);
    fireEvent.click(screen.getByText("Add driver account"));
    const form=within(screen.getByText("Add driver account").closest("details")!);
    fireEvent.change(form.getByLabelText("Driver display name"),{target:{value:"River Driver"}});
    expect(form.getByLabelText("Login ID")).toHaveValue("river-driver");
    fireEvent.change(form.getByLabelText("Workforce relationship"),{target:{value:"CONTRACTOR"}});
    fireEvent.click(screen.getByRole("button",{name:"Add driver and issue login code"}));
    await screen.findByText("FIRST-CODE-9");
    expect(createDriverAccount).toHaveBeenCalledWith({displayName:"River Driver",loginId:"river-driver",workforceRelationship:"CONTRACTOR"},expect.stringMatching(/^web-driver-account-/));
    client.clear();
  });
});
