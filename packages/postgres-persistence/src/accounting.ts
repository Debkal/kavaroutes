import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { PersistenceConflict, withTenantTransaction } from './repositories.js';

/**
 * Accounting: the costing profile an operator quotes from, the service-day estimates built
 * from it, payer invoices created from delivered trips, and a client's route history over
 * a lookback the operator chooses. Money is stored in cents; miles come from the driver's
 * own breadcrumb trace where one exists and from the profile's average otherwise, so an
 * estimate never silently pretends to know a distance it was not given.
 */

export interface CostProfileRow {
  includedBusinessInsurance?: readonly string[];
  workersCompAnnualCents?: number;
  generalLiabilityAnnualCents?: number;
  umbrellaAnnualCents?: number;
  professionalLiabilityAnnualCents?: number;
  cyberInsuranceAnnualCents?: number;
  otherInsuranceAnnualCents?: number;
  vehicleCount?: number; expectedMonthlyTrips?: number; annualFixedCostsCents?: number; useHistoricalVolume?: boolean;
  fuelCentsPerGallon: number; fuelEfficiencyMpg: number; maintenanceCentsPerMile: number;
  driverHourlyCents: number; driverBurdenPercent: number; insuranceCentsPerMonthPerVehicle: number;
  fixedOverheadCentsPerMonth: number; deadheadPercent: number; targetMarginPercent: number;
  contractedBaseCents: number; contractedCentsPerMile: number; averageTripMiles: number; loadedMilesPerHour: number;
}
const num = (value: unknown, fallback = 0) => value === null || value === undefined ? fallback : Number(value);

export function createAccountingService(pool: Pool) {
  const tx = <T>(tenantId: string, work: (db: PoolClient) => Promise<T>) => withTenantTransaction(pool, tenantId, 'kavaroutes_api', work);

  async function profileOf(db: PoolClient, tenantId: string): Promise<{ profile: CostProfileRow | null; version: number }> {
    const row = (await db.query(`SELECT * FROM billing.route_cost_profile WHERE tenant_id=$1`, [tenantId])).rows[0];
    if (!row) return { profile: null, version: 0 };
    return { version: num(row.version, 1), profile: {
      ...(row.included_business_insurance===null?{}:{includedBusinessInsurance:row.included_business_insurance}),
      workersCompAnnualCents: num(row.workers_comp_annual_cents),
      generalLiabilityAnnualCents: num(row.general_liability_annual_cents),
      umbrellaAnnualCents: num(row.umbrella_annual_cents),
      professionalLiabilityAnnualCents: num(row.professional_liability_annual_cents),
      cyberInsuranceAnnualCents: num(row.cyber_insurance_annual_cents),
      otherInsuranceAnnualCents: num(row.other_insurance_annual_cents),
      vehicleCount: num(row.vehicle_count,1), expectedMonthlyTrips:num(row.expected_monthly_trips,167),
      annualFixedCostsCents:num(row.annual_fixed_costs_cents),useHistoricalVolume:row.use_historical_volume===true,
      fuelCentsPerGallon: num(row.fuel_cents_per_gallon), fuelEfficiencyMpg: num(row.fuel_efficiency_mpg),
      maintenanceCentsPerMile: num(row.maintenance_cents_per_mile), driverHourlyCents: num(row.driver_hourly_cents),
      driverBurdenPercent: num(row.driver_burden_percent), insuranceCentsPerMonthPerVehicle: num(row.insurance_cents_per_month_per_vehicle),
      fixedOverheadCentsPerMonth: num(row.fixed_overhead_cents_per_month), deadheadPercent: num(row.deadhead_percent),
      targetMarginPercent: num(row.target_margin_percent), contractedBaseCents: num(row.contracted_base_cents),
      contractedCentsPerMile: num(row.contracted_cents_per_mile), averageTripMiles: num(row.average_trip_miles, 12),
      loadedMilesPerHour: num(row.loaded_miles_per_hour, 20),
    } };
  }

  return Object.freeze({
    async readCostProfile(tenantId: string) {
      return tx(tenantId, async db => {
        const profile = await profileOf(db, tenantId);
        const history = (await db.query(`WITH observed AS (
          SELECT t.id,t.service_date FROM intake.trip_request t
          WHERE t.tenant_id=$1 AND t.service_date < CURRENT_DATE
        ), window_start AS (
          SELECT greatest(CURRENT_DATE-90,min(service_date)) AS day FROM observed
        ) SELECT (SELECT count(*) FROM observed t WHERE t.service_date>=w.day
          AND EXISTS(SELECT 1 FROM intake.trip_leg l WHERE l.tenant_id=$1 AND l.trip_request_id=t.id)
          AND NOT EXISTS(SELECT 1 FROM intake.trip_leg l WHERE l.tenant_id=$1 AND l.trip_request_id=t.id
            AND NOT EXISTS(SELECT 1 FROM execution.leg_execution e WHERE e.tenant_id=l.tenant_id AND e.trip_leg_id=l.id AND e.lifecycle_reference='completed'))
          AND EXISTS(SELECT 1 FROM intake.trip_request r WHERE r.tenant_id=$1 AND r.id=t.id AND r.lifecycle_reference<>'cancelled')) AS completed,
          CASE WHEN EXISTS(SELECT 1 FROM observed) THEN CURRENT_DATE-w.day ELSE 0 END AS days FROM window_start w`,[tenantId])).rows[0];
        return {...profile,history:{completedTrips:num(history.completed),observationDays:num(history.days)}};
      });
    },
    async updateCostProfile(tenantId: string, input: CostProfileRow & { expectedVersion: number }) {
      return tx(tenantId, async db => {
        const current = (await db.query(`SELECT id,version FROM billing.route_cost_profile WHERE tenant_id=$1 FOR UPDATE`, [tenantId])).rows[0];
        if (current && num(current.version) !== input.expectedVersion) throw new PersistenceConflict('stale-version', 'cost profile changed');
        if (!current && input.expectedVersion !== 0) throw new PersistenceConflict('stale-version', 'cost profile does not exist yet');
        const version = input.expectedVersion + 1;
        await db.query(`INSERT INTO billing.route_cost_profile
          (tenant_id,id,fuel_cents_per_gallon,fuel_efficiency_mpg,maintenance_cents_per_mile,driver_hourly_cents,driver_burden_percent,
           insurance_cents_per_month_per_vehicle,fixed_overhead_cents_per_month,deadhead_percent,target_margin_percent,
           contracted_base_cents,contracted_cents_per_mile,average_trip_miles,loaded_miles_per_hour,version,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
          ON CONFLICT (tenant_id) DO UPDATE SET
           fuel_cents_per_gallon=EXCLUDED.fuel_cents_per_gallon,fuel_efficiency_mpg=EXCLUDED.fuel_efficiency_mpg,
           maintenance_cents_per_mile=EXCLUDED.maintenance_cents_per_mile,driver_hourly_cents=EXCLUDED.driver_hourly_cents,
           driver_burden_percent=EXCLUDED.driver_burden_percent,insurance_cents_per_month_per_vehicle=EXCLUDED.insurance_cents_per_month_per_vehicle,
           fixed_overhead_cents_per_month=EXCLUDED.fixed_overhead_cents_per_month,deadhead_percent=EXCLUDED.deadhead_percent,
           target_margin_percent=EXCLUDED.target_margin_percent,contracted_base_cents=EXCLUDED.contracted_base_cents,
           contracted_cents_per_mile=EXCLUDED.contracted_cents_per_mile,average_trip_miles=EXCLUDED.average_trip_miles,
           loaded_miles_per_hour=EXCLUDED.loaded_miles_per_hour,version=EXCLUDED.version,updated_at=now()`,
        [tenantId, current?.id ?? randomUUID(), input.fuelCentsPerGallon, input.fuelEfficiencyMpg, input.maintenanceCentsPerMile,
          input.driverHourlyCents, input.driverBurdenPercent, input.insuranceCentsPerMonthPerVehicle, input.fixedOverheadCentsPerMonth,
          input.deadheadPercent, input.targetMarginPercent, input.contractedBaseCents, input.contractedCentsPerMile,
          input.averageTripMiles, input.loadedMilesPerHour, version]);
        await db.query(`UPDATE billing.route_cost_profile SET vehicle_count=$2,expected_monthly_trips=$3,
          annual_fixed_costs_cents=$4,use_historical_volume=$5 WHERE tenant_id=$1`,
          [tenantId,input.vehicleCount??1,input.expectedMonthlyTrips??167,input.annualFixedCostsCents??0,input.useHistoricalVolume??false]);
        await db.query(`UPDATE billing.route_cost_profile SET
          workers_comp_annual_cents=COALESCE($2,workers_comp_annual_cents),
          general_liability_annual_cents=COALESCE($3,general_liability_annual_cents),
          umbrella_annual_cents=COALESCE($4,umbrella_annual_cents),
          professional_liability_annual_cents=COALESCE($5,professional_liability_annual_cents),
          cyber_insurance_annual_cents=COALESCE($6,cyber_insurance_annual_cents),
          other_insurance_annual_cents=COALESCE($7,other_insurance_annual_cents) WHERE tenant_id=$1`,
          [tenantId,input.workersCompAnnualCents??null,input.generalLiabilityAnnualCents??null,input.umbrellaAnnualCents??null,input.professionalLiabilityAnnualCents??null,input.cyberInsuranceAnnualCents??null,input.otherInsuranceAnnualCents??null]);
        await db.query('UPDATE billing.route_cost_profile SET included_business_insurance=COALESCE($2::text[],included_business_insurance) WHERE tenant_id=$1',[tenantId,input.includedBusinessInsurance??null]);
        return { version };
      });
    },

    /** Every trip on the service day with the distance the driver's trace measured (null
     * when there is no trace) and the minutes the trip is planned to occupy, which is what
     * the driver is paid for including the appointment. */
    async readServiceDayEstimates(tenantId: string, serviceDate: string) {
      return tx(tenantId, async db => {
        const { profile, version } = await profileOf(db, tenantId);
        const rows = (await db.query(`SELECT t.id AS trip_id,f.id AS client_id,f.display_name AS client_label,
            rider.synthetic_reference AS rider_label,origin.customer_label AS pickup_label,destination.customer_label AS dropoff_label,
            t.service_date,t.appointment_length_minutes,l.planned_start_at,l.planned_end_at,
            driver.synthetic_reference AS driver_label,e.lifecycle_reference AS execution_state,
            CASE WHEN e.lifecycle_reference='completed' THEN 'DELIVERED' WHEN t.lifecycle_reference='cancelled' THEN 'CANCELLED' ELSE 'PLANNED' END AS record_state,
            (SELECT round((ST_Length(ST_MakeLine(b.position::geometry ORDER BY b.captured_at)::geography)/1609.344)::numeric,2)
               FROM realtime.location_breadcrumb b JOIN realtime.location_batch_receipt r ON r.tenant_id=b.tenant_id AND r.id=b.batch_id
               JOIN execution.shift_policy_snapshot s ON s.tenant_id=r.tenant_id AND s.id=r.shift_id
               JOIN dispatch.assignment a ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id
               JOIN dispatch.run_leg rl ON rl.tenant_id=a.tenant_id AND rl.run_id=a.run_id
               JOIN intake.trip_leg tl ON tl.tenant_id=rl.tenant_id AND tl.id=rl.trip_leg_id
              WHERE b.tenant_id=t.tenant_id AND tl.trip_request_id=t.id) AS measured_miles
          FROM intake.trip_request t
          JOIN intake.trip_leg l ON l.tenant_id=t.tenant_id AND l.trip_request_id=t.id
          LEFT JOIN execution.leg_execution e ON e.tenant_id=l.tenant_id AND e.trip_leg_id=l.id
          LEFT JOIN execution.shift_policy_snapshot s ON s.tenant_id=e.tenant_id AND s.assignment_id=(SELECT a.id FROM dispatch.assignment a WHERE a.tenant_id=e.tenant_id AND a.run_id=e.run_id ORDER BY a.created_at DESC LIMIT 1)
          LEFT JOIN fleet.driver driver ON driver.tenant_id=s.tenant_id AND driver.id=s.driver_id
          LEFT JOIN intake.facility f ON f.tenant_id=t.tenant_id AND EXISTS(SELECT 1 FROM intake.facility_trip_scope sc WHERE sc.tenant_id=f.tenant_id AND sc.facility_id=f.id AND sc.trip_id=t.id)
          LEFT JOIN intake.rider rider ON rider.tenant_id=t.tenant_id AND rider.id=t.rider_id
          LEFT JOIN intake.address origin ON origin.tenant_id=l.tenant_id AND origin.id=l.origin_address_id
          LEFT JOIN intake.address destination ON destination.tenant_id=l.tenant_id AND destination.id=l.destination_address_id
          WHERE t.tenant_id=$1 AND t.service_date=$2::date ORDER BY l.planned_start_at,t.id LIMIT 300`, [tenantId, serviceDate])).rows;
        return { serviceDate, version, profile, trips: rows.map(row => ({
          tripId: String(row.trip_id), clientId: row.client_id === null ? null : String(row.client_id),
          clientLabel: row.client_label === null ? null : String(row.client_label),
          riderLabel: row.rider_label === null ? null : String(row.rider_label),
          pickupLabel: String(row.pickup_label), dropoffLabel: String(row.dropoff_label),
          plannedStartAt: new Date(row.planned_start_at).toISOString(), plannedEndAt: new Date(row.planned_end_at).toISOString(),
          appointmentLengthMinutes: num(row.appointment_length_minutes), measuredMiles: row.measured_miles === null ? null : num(row.measured_miles),
          driverLabel: row.driver_label === null ? null : String(row.driver_label), recordState: String(row.record_state),
          executionState: row.execution_state === null ? 'planned' : String(row.execution_state),
        })) };
      });
    },

    /** An invoice bills delivered trips for a period. Amounts come from the contracted
     * rate; miles from the trace where it exists, otherwise the operator's average. */
    async createInvoice(tenantId: string, input: { periodStart: string; periodEnd: string; clientId: string | null;
      payerKind: string; payerName: string; claimReference: string | null; hcpcsCode: string | null;
      authorizationNumber: string | null; proofOfService: string }) {
      return tx(tenantId, async db => {
        const { profile } = await profileOf(db, tenantId);
        if (!profile) throw new PersistenceConflict('relationship', 'a cost profile is required before invoicing');
        const lines = (await db.query(`SELECT t.id AS trip_id,t.service_date,l.planned_start_at,l.planned_end_at,t.appointment_length_minutes,
            origin.customer_label AS pickup_label,destination.customer_label AS dropoff_label,
            (SELECT 1 FROM execution.driver_service_proof p WHERE p.tenant_id=l.tenant_id AND p.execution_id=e.id LIMIT 1) AS has_proof,
            (SELECT round((ST_Length(ST_MakeLine(b.position::geometry ORDER BY b.captured_at)::geography)/1609.344)::numeric,2)
               FROM realtime.location_breadcrumb b JOIN realtime.location_batch_receipt r ON r.tenant_id=b.tenant_id AND r.id=b.batch_id
              WHERE b.tenant_id=t.tenant_id AND r.shift_id IN (SELECT s.id FROM execution.shift_policy_snapshot s JOIN dispatch.assignment a ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id
                 WHERE a.run_id=e.run_id)) AS measured_miles
          FROM intake.trip_request t
          JOIN intake.trip_leg l ON l.tenant_id=t.tenant_id AND l.trip_request_id=t.id
          JOIN execution.leg_execution e ON e.tenant_id=l.tenant_id AND e.trip_leg_id=l.id AND e.lifecycle_reference='completed'
          JOIN intake.address origin ON origin.tenant_id=l.tenant_id AND origin.id=l.origin_address_id
          JOIN intake.address destination ON destination.tenant_id=l.tenant_id AND destination.id=l.destination_address_id
          WHERE t.tenant_id=$1 AND t.service_date BETWEEN $2::date AND $3::date AND t.lifecycle_reference<>'cancelled'
            AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM intake.facility_trip_scope sc WHERE sc.tenant_id=t.tenant_id AND sc.facility_id=$4::uuid AND sc.trip_id=t.id))
          ORDER BY t.service_date,l.planned_start_at LIMIT 500`,
        [tenantId, input.periodStart, input.periodEnd, input.clientId])).rows;
        if (!lines.length) throw new PersistenceConflict('relationship', 'no delivered trips in that period');
        const invoiceId = randomUUID();
        let totalCents = 0, totalMiles = 0;
        const prepared = lines.map((row, index) => {
          const miles = row.measured_miles === null ? profile.averageTripMiles : num(row.measured_miles);
          const minutes = Math.round((new Date(row.planned_end_at).getTime() - new Date(row.planned_start_at).getTime()) / 60_000) + num(row.appointment_length_minutes);
          const amountCents = Math.round(profile.contractedBaseCents + profile.contractedCentsPerMile * miles);
          totalCents += amountCents; totalMiles += miles;
          const proof = row.has_proof ? 'SIGNATURE_ON_FILE' : (input.proofOfService === 'MISSING' ? 'DRIVER_ATTESTED' : input.proofOfService);
          return { ordinal: index + 1, tripId: String(row.trip_id), serviceDate: new Date(row.service_date).toISOString().slice(0, 10),
            description: `${String(row.pickup_label)} → ${String(row.dropoff_label)}`.slice(0, 300), miles,
            hcpcsCode: input.hcpcsCode, authorizationNumber: input.authorizationNumber, proofOfService: proof, amountCents, minutes };
        });
        await db.query(`INSERT INTO billing.payer_invoice
          (tenant_id,id,client_id,payer_kind,payer_name,claim_reference,period_start,period_end,status,total_cents,total_miles,aggregate_version)
          VALUES($1,$2,$3,$4,$5,$6,$7::date,$8::date,'DRAFT',$9,$10,1)`,
        [tenantId, invoiceId, input.clientId, input.payerKind, input.payerName, input.claimReference, input.periodStart, input.periodEnd,
          Math.round(totalCents), Number(totalMiles.toFixed(2))]);
        for (const line of prepared) {
          await db.query(`INSERT INTO billing.payer_invoice_line
            (tenant_id,invoice_id,ordinal,trip_id,service_date,description,miles,hcpcs_code,authorization_number,proof_of_service,amount_cents)
            VALUES($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11)`,
          [tenantId, invoiceId, line.ordinal, line.tripId, line.serviceDate, line.description, line.miles, line.hcpcsCode,
            line.authorizationNumber, line.proofOfService, line.amountCents]);
        }
        await db.query(`INSERT INTO billing.payer_invoice_event(tenant_id,id,invoice_id,aggregate_version,action_reference,actor_reference,detail)
          VALUES($1,$2,$3,1,'CREATED',$4,$5)`, [tenantId, randomUUID(), invoiceId, input.payerName, `${prepared.length} delivered trip(s)`]);
        return { invoiceId, totalCents: Math.round(totalCents), totalMiles: Number(totalMiles.toFixed(2)), lineCount: prepared.length,
          sumMinutes: prepared.reduce((sum, line) => sum + line.minutes, 0) };
      });
    },

    async listInvoices(tenantId: string, limit: number) {
      return tx(tenantId, async db => {
        const rows = (await db.query(`SELECT i.*,c.display_name AS client_label,
            (SELECT count(*)::int FROM billing.payer_invoice_line l WHERE l.tenant_id=i.tenant_id AND l.invoice_id=i.id) AS line_count
          FROM billing.payer_invoice i LEFT JOIN intake.facility c ON c.tenant_id=i.tenant_id AND c.id=i.client_id
          WHERE i.tenant_id=$1 ORDER BY i.created_at DESC,i.id LIMIT $2`, [tenantId, Math.min(200, Math.max(1, limit))])).rows;
        return rows.map(row => ({ invoiceId: String(row.id), clientId: row.client_id === null ? null : String(row.client_id),
          clientLabel: row.client_label === null ? null : String(row.client_label), payerKind: String(row.payer_kind),
          payerName: String(row.payer_name), claimReference: row.claim_reference === null ? null : String(row.claim_reference),
          periodStart: new Date(row.period_start).toISOString().slice(0, 10), periodEnd: new Date(row.period_end).toISOString().slice(0, 10),
          status: String(row.status), totalCents: num(row.total_cents), totalMiles: num(row.total_miles), lineCount: num(row.line_count),
          forwardedAt: row.forwarded_at === null ? null : new Date(row.forwarded_at).toISOString(),
          forwardedMethod: row.forwarded_method === null ? null : String(row.forwarded_method),
          forwardedTo: row.forwarded_to === null ? null : String(row.forwarded_to),
          aggregateVersion: num(row.aggregate_version, 1),
          createdAt: new Date(row.created_at).toISOString() }));
      });
    },

    /** One invoice with the trips it bills: what an export or a paper claim packet needs. */
    async readInvoice(tenantId: string, invoiceId: string) {
      return tx(tenantId, async db => {
        const row = (await db.query(`SELECT i.*,c.display_name AS client_label FROM billing.payer_invoice i
          LEFT JOIN intake.facility c ON c.tenant_id=i.tenant_id AND c.id=i.client_id
          WHERE i.tenant_id=$1 AND i.id=$2`, [tenantId, invoiceId])).rows[0];
        if (!row) return null;
        const lines = (await db.query(`SELECT ordinal,trip_id,service_date,description,miles,hcpcs_code,authorization_number,proof_of_service,amount_cents
          FROM billing.payer_invoice_line WHERE tenant_id=$1 AND invoice_id=$2 ORDER BY ordinal`, [tenantId, invoiceId])).rows;
        return {
          invoiceId: String(row.id), clientId: row.client_id === null ? null : String(row.client_id),
          clientLabel: row.client_label === null ? null : String(row.client_label), payerKind: String(row.payer_kind),
          payerName: String(row.payer_name), claimReference: row.claim_reference === null ? null : String(row.claim_reference),
          periodStart: new Date(row.period_start).toISOString().slice(0, 10), periodEnd: new Date(row.period_end).toISOString().slice(0, 10),
          status: String(row.status), totalCents: num(row.total_cents), totalMiles: num(row.total_miles), lineCount: lines.length,
          forwardedAt: row.forwarded_at === null ? null : new Date(row.forwarded_at).toISOString(),
          forwardedMethod: row.forwarded_method === null ? null : String(row.forwarded_method),
          forwardedTo: row.forwarded_to === null ? null : String(row.forwarded_to),
          aggregateVersion: num(row.aggregate_version, 1), createdAt: new Date(row.created_at).toISOString(),
          lines: lines.map(line => ({ ordinal: num(line.ordinal), tripId: String(line.trip_id),
            serviceDate: new Date(line.service_date).toISOString().slice(0, 10), description: String(line.description),
            miles: num(line.miles), hcpcsCode: line.hcpcs_code === null ? null : String(line.hcpcs_code),
            authorizationNumber: line.authorization_number === null ? null : String(line.authorization_number),
            proofOfService: String(line.proof_of_service), amountCents: num(line.amount_cents) })),
        };
      });
    },

    /** Forwarding is recorded, not performed: the operator exports the claim packet (CSV
     * or CMS-1500 layout) and tells the system where it went, so the trail exists. */
    async forwardInvoice(tenantId: string, actorReference: string, input: { invoiceId: string; expectedVersion: number;
      method: 'EXPORT' | 'EMAIL' | 'PORTAL' | 'POST'; forwardedTo: string; claimReference: string | null }) {
      return tx(tenantId, async db => {
        const row = (await db.query(`SELECT id,status,aggregate_version FROM billing.payer_invoice WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [tenantId, input.invoiceId])).rows[0];
        if (!row) throw new PersistenceConflict('relationship', 'invoice hidden');
        if (num(row.aggregate_version) !== input.expectedVersion) throw new PersistenceConflict('stale-version', 'invoice changed');
        if (row.status === 'VOID' || row.status === 'PAID') throw new PersistenceConflict('relationship', 'a closed invoice cannot be forwarded again');
        const version = input.expectedVersion + 1;
        await db.query(`UPDATE billing.payer_invoice SET status='SENT',forwarded_at=now(),forwarded_method=$3,forwarded_to=$4,
          claim_reference=COALESCE($5,claim_reference),aggregate_version=$6,updated_at=now() WHERE tenant_id=$1 AND id=$2`,
        [tenantId, input.invoiceId, input.method, input.forwardedTo, input.claimReference, version]);
        await db.query(`INSERT INTO billing.payer_invoice_event(tenant_id,id,invoice_id,aggregate_version,action_reference,actor_reference,detail)
          VALUES($1,$2,$3,$4,'FORWARDED',$5,$6)`, [tenantId, randomUUID(), input.invoiceId, version, actorReference, `${input.method} → ${input.forwardedTo}`.slice(0, 200)]);
        return { invoiceId: input.invoiceId, status: 'SENT' as const, aggregateVersion: version };
      });
    },

    /** A client's trips over a lookback the operator chooses, with the totals that answer
     * "how much work has this client given us, and how far did we drive for it". */
    async readClientHistory(tenantId: string, clientId: string, days: number) {
      return tx(tenantId, async db => {
        const window = Math.min(3650, Math.max(1, Math.round(days)));
        const rows = (await db.query(`SELECT t.id AS trip_id,t.service_date,t.lifecycle_reference AS trip_state,
            t.appointment_length_minutes,l.planned_start_at,l.planned_end_at,origin.customer_label AS pickup_label,destination.customer_label AS dropoff_label,
            e.lifecycle_reference AS execution_state,driver.synthetic_reference AS driver_label,
            (SELECT round((ST_Length(ST_MakeLine(b.position::geometry ORDER BY b.captured_at)::geography)/1609.344)::numeric,2)
               FROM realtime.location_breadcrumb b JOIN realtime.location_batch_receipt r ON r.tenant_id=b.tenant_id AND r.id=b.batch_id
              WHERE b.tenant_id=t.tenant_id AND r.shift_id IN (SELECT s.id FROM execution.shift_policy_snapshot s JOIN dispatch.assignment a ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id
                 WHERE a.run_id=e.run_id)) AS measured_miles,
            (SELECT count(*)::int FROM execution.driver_service_proof p WHERE p.tenant_id=l.tenant_id AND p.execution_id=e.id) AS proof_count
          FROM intake.trip_request t
          JOIN intake.trip_leg l ON l.tenant_id=t.tenant_id AND l.trip_request_id=t.id
          JOIN intake.facility_trip_scope sc ON sc.tenant_id=t.tenant_id AND sc.trip_id=t.id AND sc.facility_id=$2
          LEFT JOIN execution.leg_execution e ON e.tenant_id=l.tenant_id AND e.trip_leg_id=l.id
          LEFT JOIN execution.shift_policy_snapshot s ON s.tenant_id=e.tenant_id AND s.assignment_id=(SELECT a.id FROM dispatch.assignment a WHERE a.tenant_id=e.tenant_id AND a.run_id=e.run_id ORDER BY a.created_at DESC LIMIT 1)
          LEFT JOIN fleet.driver driver ON driver.tenant_id=s.tenant_id AND driver.id=s.driver_id
          LEFT JOIN intake.address origin ON origin.tenant_id=l.tenant_id AND origin.id=l.origin_address_id
          LEFT JOIN intake.address destination ON destination.tenant_id=l.tenant_id AND destination.id=l.destination_address_id
          WHERE t.tenant_id=$1 AND t.service_date >= (CURRENT_DATE - ($3::int - 1) * INTERVAL '1 day')
          ORDER BY t.service_date DESC,l.planned_start_at DESC LIMIT 500`, [tenantId, clientId, window])).rows;
        const trips = rows.map(row => ({ tripId: String(row.trip_id), serviceDate: new Date(row.service_date).toISOString().slice(0, 10),
          pickupLabel: row.pickup_label === null ? null : String(row.pickup_label), dropoffLabel: row.dropoff_label === null ? null : String(row.dropoff_label),
          plannedStartAt: new Date(row.planned_start_at).toISOString(), appointmentLengthMinutes: num(row.appointment_length_minutes),
          tripState: String(row.trip_state), executionState: row.execution_state === null ? 'planned' : String(row.execution_state),
          driverLabel: row.driver_label === null ? null : String(row.driver_label), measuredMiles: row.measured_miles === null ? null : num(row.measured_miles),
          proofCount: num(row.proof_count) }));
        const delivered = trips.filter(trip => trip.executionState === 'completed');
        const cancelled = trips.filter(trip => trip.tripState === 'cancelled');
        return { clientId, days: window, trips,
          totals: { trips: trips.length, delivered: delivered.length, cancelled: cancelled.length,
            measuredMiles: Number(delivered.reduce((sum, trip) => sum + (trip.measuredMiles ?? 0), 0).toFixed(2)),
            appointmentMinutes: trips.reduce((sum, trip) => sum + trip.appointmentLengthMinutes, 0),
            tripsWithProof: delivered.filter(trip => trip.proofCount > 0).length } };
      });
    },
  });
}
export type AccountingService = ReturnType<typeof createAccountingService>;
