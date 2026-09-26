# Illinois wheelchair-van pricing baseline — September 25, 2026

This is a planning estimate for the two-leg live test run, not an insurance quote or a revision to a payer contract. The customer charge supplied by the operator was **$340 for the trip plus $65 for each billable waiting hour**. One waiting hour makes the observed-charge scenario **$405**. The trip charge is revenue, not a cost input.

## Recorded work

The privacy-minimal live trip report records two completed legs in `America/Chicago`: first rider boarded at 12:52:47 PM and completed at 1:26:47 PM; second rider boarded at 2:20:32 PM and completed at 3:00:33 PM. The shift started at 12:51:31 PM and ended after dispatch approved sign-off at 3:04:01 PM, about 132.5 paid minutes. The planned appointment length is 55 minutes; the gap from first completion to second pickup arrival is about 53 minutes 34 seconds. This supports a *provisional* one-hour wait charge. It does not prove every minute was billable waiting, because the GPS feed was overdue during most of that gap.

A read-only aggregation of accurate GPS fixes (at most 100 m reported accuracy) between each leg's `BOARD_RIDER` and `COMPLETE_LEG` receipts gives **14.72 mi** and **14.32 mi**, or **29.04 passenger miles** total. The Accounting API currently reports 30.7 mi on *each* leg because it joins the full shift trace to both legs. The local code change scopes trace miles to each leg's boarded/completed interval for estimates, invoices and client history. That fix must be deployed before using app mileage for billing.

## Research inputs and working assumptions

AAA's [Illinois fuel average](https://gasprices.aaa.com/?state=IL) on September 25 was **$4.828/gal regular** and **$6.821/gal diesel**. This calculation assumes the van uses regular gasoline and rounds the profile input to **483 cents/gal**. If the actual van is diesel, substitute the diesel price and its measured MPG. The existing 14 MPG and 15% additional empty miles remain estimates until odometer/fill-up records establish actual values.

[Grandbay Financial's 2026 NEMT placement range](https://www.grandbayfinancial.com/insights/nemt-insurance-costs-2026) is **$11,000–$18,000 annually per wheelchair-accessible van** for a small fleet's complete insurance package. [KTL's NEMT benchmark](https://ktlbusinessins.com/nemt-insurance-cost-and-requirements) lists **$7,000–$10,000 annually per wheelchair van for commercial auto alone**, with other coverages and new-venture surcharges separate. These are broker-reported averages, not a cap or an Illinois quote. The operator expects insurance **could exceed $1,800/month ($21,600/year)**, so the existing app profile's **$1,000/month** allowance is too low for this planning exercise. The primary scenario below uses **$2,000/month** as an illustrative insurance budget; it is not a claimed premium or derived from the $340 fare. A real premium depends on driver records, vehicle/securement, territory, passenger assistance, limits and claims history. Include all required policies, and avoid double-counting a business policy already included in a package quote.

Other existing profile assumptions retained for this baseline: **$18/hour driver wage**, **30% wage burden**, **$0.15/mile maintenance**, **$800/month company overhead**, and **15% deadhead miles**. These omit any separate vehicle loan/depreciation, tolls, parking, licenses or other expenses not already in overhead. The door-through-door assistance is included only to the extent it falls within the recorded paid shift; an extra attendant or work outside that interval must be added separately.

## Cost and volume sensitivity

The current profile assumes 167 completed one-way rides/month, but the accounting history shows nine completed trips over the last 14 days, roughly **19 rides/month** at that pace. Because some of those may be tests, **20 rides/month is a provisional low-volume planning case**, not a demand forecast. A round trip consumes two one-way fixed-cost shares.

| Cost component, two-leg run | At 20 rides/month, $2,000/month insurance |
| --- | ---: |
| Fuel: 29.04 mi × 1.15 ÷ 14 MPG × $4.83 | $11.52 |
| Maintenance: 29.04 mi × 1.15 × $0.15 | $5.01 |
| Driver: 132.5 min × $18/hr × 1.30 | $51.68 |
| Insurance: $2,000/month ÷ 20 × 2 legs | $200.00 |
| Other overhead: $800/month ÷ 20 × 2 legs | $80.00 |
| **Estimated operating cost** | **$348.21** |
| **Customer charge with one waiting hour** | **$405.00** |
| **Estimated contribution after listed costs** | **$56.79 (14.0%)** |

At **$1,800 / $2,000 / $2,500** insurance per month and 20 one-way rides/month, the same run costs **$328.21 / $348.21 / $398.21**. At $405 revenue, the respective contributions are **$76.79 (19.0%) / $56.79 (14.0%) / $6.79 (1.7%)**. Without a billable waiting hour, the $340 charge falls **$8.21 short** in the $2,000 scenario. With one billed hour and 20 rides/month, insurance above about **$2,568/month** consumes all the listed contribution. These are sensitivity scenarios, not observed profit.

At the $2,000/month insurance budget, **40 / 80 / 167** completed one-way rides per month would bring this run's allocated cost to approximately **$208.21 / $138.21 / $101.74**. Higher utilization spreads fixed costs, but 167 rides/month is the existing profile's assumption, not the observed volume.

The existing contracted-rate fields are **$45 base per one-way ride plus $2.50 per passenger mile**. On the corrected 29.04 miles, those fields would price the two legs at about **$162.60 before waiting**, far below the operator's stated $340 trip charge. Do not use an invoice generated from those fields for this agreement until its actual rate structure is entered. The Quick quote now accepts the agreed trip charge and waiting rate separately so it can show the actual-charge margin without changing the global contracted-rate profile.

## Profile draft

For the test business, use **483 fuel cents/gal** if the wheelchair van takes regular gas; retain **14 MPG, 15 maintenance cents/mile, 18 driver dollars/hour, 30% wage burden, $800/month overhead and 15% deadhead** as explicit provisional assumptions. Replace the app's **$1,000/month insurance** assumption with **$2,000/month for scenario planning**, then replace that with the actual full insurance budget when quoted; also test $1,800 and $2,500. Use **20 one-way rides/month** to stress-test today's low-volume operation, and review again with actual operating volume. Keep **$340 trip charge and $65/hour waiting charge** as this agreement's quote inputs. The current global contracted base/per-mile fields are not a faithful representation of that agreement.
