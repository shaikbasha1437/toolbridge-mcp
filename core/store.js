/* The fictional adapter's data store: seed data in memory, with an optional persistence hook for the
   mutable parts (tickets). Node persists to a JSON file; the playground persists to localStorage. */
import { EMPLOYEES, TICKETS, ASSETS, EXPENSES, ONCALL, WIKI, COMPANY } from './seed.js';
const clone = (x) => JSON.parse(JSON.stringify(x));
export function createStore(opts) {
  const o = opts || {};
  const saved = o.load ? o.load() : null;
  const state = {
    tickets: saved && Array.isArray(saved.tickets) ? saved.tickets : clone(TICKETS),
    nextTicket: saved && saved.nextTicket ? saved.nextTicket : 1015,
    version: 1
  };
  const employees = clone(EMPLOYEES); const byId = new Map(employees.map((e) => [e.id, e])); const byEmail = new Map(employees.map((e) => [e.email, e]));
  function persist() { state.version++; if (o.save) o.save({ tickets: state.tickets, nextTicket: state.nextTicket }); }
  return {
    company: COMPANY,
    employees, assets: clone(ASSETS), expenses: clone(EXPENSES), oncall: clone(ONCALL), wiki: clone(WIKI),
    get tickets() { return state.tickets; },
    get version() { return state.version; },
    employee(idOrEmail) { const k = String(idOrEmail || '').trim(); return byId.get(k.toUpperCase()) || byEmail.get(k.toLowerCase()) || null; },
    ticket(id) { return state.tickets.find((t) => t.id === String(id || '').trim().toUpperCase()) || null; },
    nextTicketId() { return 'IT-' + state.nextTicket; },
    insertTicket(t) { state.tickets.push(t); state.nextTicket++; persist(); return t; },
    replaceTicket(t) { const i = state.tickets.findIndex((x) => x.id === t.id); state.tickets[i] = t; persist(); return t; },
    snapshot() { return clone({ tickets: state.tickets, nextTicket: state.nextTicket }); },
    restore(snap) { state.tickets = clone(snap.tickets); state.nextTicket = snap.nextTicket; persist(); },
    reset() { state.tickets = clone(TICKETS); state.nextTicket = 1015; persist(); }
  };
}
