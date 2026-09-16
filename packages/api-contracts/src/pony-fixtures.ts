/** Closed, non-secret catalog for private synthetic QA only.
 * Display names and selections are not authentication or policy authority.
 * Seeded database membership/policy and the server verifier must agree.
 */
export const ponyCompanies = Object.freeze([
  Object.freeze({ key: 'ponytransport', name: 'PonyTransport', tier: 'SMALL_BUSINESS',
    organizationId: '71000000-0000-4000-8000-000000000001',
    driverSubjectId: '71000000-0000-4000-8000-000000000010' }),
  Object.freeze({ key: 'ponybigbusiness', name: 'PonyBigBusiness', tier: 'ENTERPRISE',
    organizationId: '72000000-0000-4000-8000-000000000001',
    driverSubjectId: '72000000-0000-4000-8000-000000000010' }),
] as const);

export const ponyPersonas = Object.freeze(ponyCompanies.flatMap(company => [
  Object.freeze({ companyKey: company.key, organizationId: company.organizationId,
    role: 'driver' as const, displayName: 'PonyDriver',
    principalId: company.key === 'ponytransport' ? '71000000-0000-4000-8000-000000000011' : '72000000-0000-4000-8000-000000000011',
    subjectId: company.driverSubjectId, token: `principal_${company.key}_driver` }),
  Object.freeze({ companyKey: company.key, organizationId: company.organizationId,
    role: 'dispatcher' as const, displayName: 'PonyDispatch',
    principalId: company.key === 'ponytransport' ? '71000000-0000-4000-8000-000000000012' : '72000000-0000-4000-8000-000000000012',
    subjectId: undefined, token: `principal_${company.key}_dispatcher` }),
]));

export function selectPonyPersona(companyKey: string, role: string) {
  const persona = ponyPersonas.find(value => value.companyKey === companyKey && value.role === role);
  if (!persona) throw new Error('PONY_PERSONA_NOT_FOUND');
  return persona;
}
