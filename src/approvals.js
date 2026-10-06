import { randomUUID, randomBytes } from 'node:crypto';
import { print } from 'graphql';
import { approvalBinding, permissionErrors, problem } from './operation-meta.js';

export function createApprovals({ now = Date.now, ttlMs = 300_000 } = {}) {
  const requests = new Map();
  function get(id) {
    const entry = requests.get(id);
    if (entry && now() >= entry.expires) { entry.status = 'EXPIRED'; entry.token = null; }
    return entry;
  }
  return {
    request(inspector, input, caller) {
      const a = inspector.inspect(input.document, input.variables, input.operationName, caller);
      if (permissionErrors(a).length) throw problem('UNAUTHORIZED_FIELD_OR_TYPE', 'You cannot request approval for an operation you cannot run.');
      if (!a.selections.some(s => s.meta.approval)) throw problem('BAD_USER_INPUT', 'This operation does not require approval.');
      const id = randomUUID();
      const expires = now() + ttlMs;
      const entry = { id, callerId: caller.id, status: 'PENDING', token: null, expires, expiresAt: new Date(expires).toISOString(),
        binding: approvalBinding(a, caller),
        preview: { document: print(a.document), operationName: a.operationName, variables: a.variables, operationMeta: a.operationMeta },
      };
      requests.set(id, entry);
      return entry;
    },
    read(id, caller) {
      const entry = get(id);
      return entry?.callerId === caller.id ? entry : null;
    },
    pending() { return [...requests.keys()].map(get).filter(e => e.status === 'PENDING'); },
    decide(id, approved, reviewer) {
      if (reviewer.id !== 'admin') throw problem('UNAUTHORIZED_FIELD_OR_TYPE', 'Only the demo reviewer can decide.');
      const entry = get(id);
      if (!entry || entry.status !== 'PENDING') throw problem('BAD_USER_INPUT', 'Approval is missing, expired, or already decided.');
      entry.status = approved ? 'APPROVED' : 'DENIED';
      entry.token = approved ? randomBytes(32).toString('base64url') : null;
      return { id, status: entry.status };
    },
    consume(token, binding) {
      if (!token) return false;
      const entry = [...requests.values()].find(e => e.token === token);
      if (!entry || get(entry.id).status !== 'APPROVED' || entry.binding !== binding) return false;
      entry.status = 'USED'; entry.token = null;
      return true;
    },
    reset() { requests.clear(); },
  };
}
