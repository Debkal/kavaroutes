import { render } from "@testing-library/react-native";
import { StatusCard } from "../src/components/StatusCard";
test("status is exposed through text and an accessible summary", async () => {
  const surface = await render(<StatusCard title="Tracking" status="STOPPED BY DRIVER" />);
  expect(surface.getByRole("summary", { name: "Tracking: STOPPED BY DRIVER" })).toBeTruthy();
  expect(surface.getByText("STOPPED BY DRIVER")).toBeTruthy();
});
