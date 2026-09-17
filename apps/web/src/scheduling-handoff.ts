// One ephemeral client reference across in-app navigation; no address, name,
// URL, history-state payload, or browser persistence. Dispatch re-reads scope.
let clientReference: string | null = null;
export function prepareClientScheduling(reference:string):void { clientReference=reference; }
export function scheduledClientReference():string|null { return clientReference; }
export function clearClientScheduling():void { clientReference=null; }
