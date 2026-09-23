// Planning assumptions in USD; sources and measurement limits are in CAPACITY-AND-PRICING.md.
export const defaults={businesses:100,enterprisePercent:20,smallDrivers:3,smallOffice:2,smallTrips:10,enterpriseDrivers:25,enterpriseOffice:15,enterpriseTrips:60,days:22,hours:10,gpsSeconds:30,officeRequestsPerMinute:60,peakMultiplier:3,smallPrice:199,enterprisePrice:499,fixedMonthly:1500,otherPerBusiness:10,supportHourly:35,smallSupportHours:.5,enterpriseSupportHours:2,routesPerTrip:2,geocodesPerTrip:.2,mapLoadsPerOfficeDay:2,paymentPercent:3.6,paymentFixed:.30,targetMargin:70};
export function mapsTierCost(events,rate){
 const bounds=[100000,500000,1000000,5000000,Infinity],rates=rate===7?[7,5.6,4.2,2.1,.53]:[5,4,3,1.5,.38];let from=10000,total=0;
 for(let i=0;i<bounds.length;i++){const count=Math.max(0,Math.min(events,bounds[i])-from);total+=count/1000*rates[i];from=bounds[i];}return total;
}
export function costModel(input){
 const v={...defaults,...input};
 for(const value of Object.values(v))if(!Number.isFinite(value)||value<0||value>1e7)throw new Error('Use nonnegative, finite planning values.');
 if(v.businesses<1||!Number.isInteger(v.businesses)||v.enterprisePercent>100||v.gpsSeconds<1||v.hours<1||v.days<1||v.days>31||v.paymentPercent+v.targetMargin>=100)throw new Error('Check business count, percentages, work hours/days and GPS interval.');
 const enterprise=Math.round(v.businesses*v.enterprisePercent/100),small=v.businesses-enterprise;
 const drivers=small*v.smallDrivers+enterprise*v.enterpriseDrivers,office=small*v.smallOffice+enterprise*v.enterpriseOffice;
 const tripsDaily=small*v.smallTrips+enterprise*v.enterpriseTrips,tripsMonthly=tripsDaily*v.days;
 const routes=tripsMonthly*v.routesPerTrip,geocodes=tripsMonthly*v.geocodesPerTrip,mapLoads=office*v.days*v.mapLoadsPerOfficeDay;
 const maps=mapsTierCost(routes,5)+mapsTierCost(geocodes,5)+mapsTierCost(mapLoads,7);
 const support=(small*v.smallSupportHours+enterprise*v.enterpriseSupportHours)*v.supportHourly;
 const baseCosts=v.fixedMonthly+v.otherPerBusiness*v.businesses+support+maps;
 const revenue=small*v.smallPrice+enterprise*v.enterprisePrice,fees=revenue*v.paymentPercent/100+v.businesses*v.paymentFixed;
 const averageFloor=(baseCosts/v.businesses+v.paymentFixed)/(1-v.paymentPercent/100);
 const targetPrice=(baseCosts/v.businesses+v.paymentFixed)/(1-v.paymentPercent/100-v.targetMargin/100);
 const denominator=1-v.paymentPercent/100-v.targetMargin/100;
 // Allocate aggregate Maps cost by tier's modeled events, keeping billing-account free caps shared.
 const weightsSmall=v.smallTrips*(v.routesPerTrip+v.geocodesPerTrip)+v.smallOffice*v.mapLoadsPerOfficeDay*1.4;
 const weightsEnterprise=v.enterpriseTrips*(v.routesPerTrip+v.geocodesPerTrip)+v.enterpriseOffice*v.mapLoadsPerOfficeDay*1.4;
 const weights=small*weightsSmall+enterprise*weightsEnterprise;
 const tierPrice=(supportHours,weight)=>(v.fixedMonthly/v.businesses+v.otherPerBusiness+supportHours*v.supportHourly+(weights?maps*weight/weights:0)+v.paymentFixed)/denominator;
 const gpsRps=drivers/v.gpsSeconds,officeRps=office*v.officeRequestsPerMinute/60,tripRps=tripsDaily*12/(v.hours*3600);
 return {small,enterprise,drivers,office,tripsMonthly,routes,geocodes,mapLoads,maps,support,baseCosts,revenue,fees,profit:revenue-baseCosts-fees,margin:revenue?(revenue-baseCosts-fees)/revenue*100:0,averageFloor,targetPrice,smallTarget:tierPrice(v.smallSupportHours,weightsSmall),enterpriseTarget:tierPrice(v.enterpriseSupportHours,weightsEnterprise),gpsRps,officeRps,tripRps,estimatedPeakRps:(gpsRps+officeRps+tripRps)*v.peakMultiplier,gpsEventsMonthly:drivers*v.hours*3600/v.gpsSeconds*v.days,concurrentSockets:drivers+office};
}
