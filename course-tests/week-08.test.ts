import { deduplicateOperations, resolveSync } from '../src/course-evaluation';
import type { SyncRecord } from '../src/course-evaluation/contracts';

describe('Week 08 - Synchronization & Idempotency (Cleber)', () => {
  describe('resolveSync 3-way merge algorithm', () => {
    it('merges independent changes when local and remote edit different fields', () => {
      const base: SyncRecord = {
        id: 'inc-001',
        version: 1,
        fields: { title: 'Luz fundida', priority: 'medium', notes: 'Revisar foco' },
      };
      const local: SyncRecord = {
        id: 'inc-001',
        version: 1,
        fields: { title: 'Luz fundida', priority: 'high', notes: 'Revisar foco' },
      };
      const remote: SyncRecord = {
        id: 'inc-001',
        version: 2,
        fields: { title: 'Luz fundida', priority: 'medium', notes: 'Revisar foco y balastro' },
      };

      const result = resolveSync(base, local, remote);
      expect(result).toEqual({
        kind: 'merged',
        fields: {
          title: 'Luz fundida',
          priority: 'high',
          notes: 'Revisar foco y balastro',
        },
      });
    });

    it('merges cleanly when both local and remote apply the exact same modification', () => {
      const base: SyncRecord = {
        id: 'inc-002',
        version: 1,
        fields: { status: 'open', severity: 2 },
      };
      const local: SyncRecord = {
        id: 'inc-002',
        version: 1,
        fields: { status: 'in_progress', severity: 2 },
      };
      const remote: SyncRecord = {
        id: 'inc-002',
        version: 2,
        fields: { status: 'in_progress', severity: 2 },
      };

      const result = resolveSync(base, local, remote);
      expect(result).toEqual({
        kind: 'merged',
        fields: {
          status: 'in_progress',
          severity: 2,
        },
      });
    });

    it('handles additions of new independent fields from local or remote', () => {
      const base: SyncRecord = {
        id: 'inc-003',
        version: 1,
        fields: { title: 'Fuga' },
      };
      const local: SyncRecord = {
        id: 'inc-003',
        version: 1,
        fields: { title: 'Fuga', localNote: 'Foto capturada offline' },
      };
      const remote: SyncRecord = {
        id: 'inc-003',
        version: 2,
        fields: { title: 'Fuga', remoteTag: 'plumbing' },
      };

      const result = resolveSync(base, local, remote);
      expect(result).toEqual({
        kind: 'merged',
        fields: {
          title: 'Fuga',
          localNote: 'Foto capturada offline',
          remoteTag: 'plumbing',
        },
      });
    });

    it('detects conflict when local and remote alter the same scalar field to different values', () => {
      const base: SyncRecord = {
        id: 'inc-004',
        version: 1,
        fields: { priority: 'low' },
      };
      const local: SyncRecord = {
        id: 'inc-004',
        version: 1,
        fields: { priority: 'medium' },
      };
      const remote: SyncRecord = {
        id: 'inc-004',
        version: 2,
        fields: { priority: 'high' },
      };

      const result = resolveSync(base, local, remote);
      expect(result).toEqual({
        kind: 'conflict',
        fields: ['priority'],
      });
    });

    it('detects nested conflict in CampusOps work domain (offline start vs remote reassignment)', () => {
      const base: SyncRecord = {
        id: 'campus-inc-001',
        version: 1,
        fields: {
          work: { assignedTechnicianId: 'technician-1', status: 'assigned' },
        },
      };
      const local: SyncRecord = {
        id: 'campus-inc-001',
        version: 1,
        fields: {
          work: { assignedTechnicianId: 'technician-1', status: 'in_progress' },
        },
      };
      const remote: SyncRecord = {
        id: 'campus-inc-001',
        version: 2,
        fields: {
          work: { assignedTechnicianId: 'technician-2', status: 'assigned' },
        },
      };

      const result = resolveSync(base, local, remote);
      expect(result).toEqual({
        kind: 'conflict',
        fields: ['work'],
      });
    });

    it('sorts multiple conflicting fields alphabetically in output', () => {
      const base: SyncRecord = {
        id: 'inc-005',
        version: 1,
        fields: { zebra: 'old_z', apple: 'old_a', mango: 'old_m' },
      };
      const local: SyncRecord = {
        id: 'inc-005',
        version: 1,
        fields: { zebra: 'local_z', apple: 'local_a', mango: 'local_m' },
      };
      const remote: SyncRecord = {
        id: 'inc-005',
        version: 2,
        fields: { zebra: 'remote_z', apple: 'remote_a', mango: 'remote_m' },
      };

      const result = resolveSync(base, local, remote);
      expect(result).toEqual({
        kind: 'conflict',
        fields: ['apple', 'mango', 'zebra'],
      });
    });

    it('guarantees strict inmutability of base, local, and remote inputs', () => {
      const base: SyncRecord = Object.freeze({
        id: 'inc-immutable',
        version: 1,
        fields: Object.freeze({
          work: Object.freeze({ assignedTechnicianId: 'technician-1', status: 'assigned' }),
        }),
      });
      const local: SyncRecord = Object.freeze({
        id: 'inc-immutable',
        version: 1,
        fields: Object.freeze({
          work: Object.freeze({ assignedTechnicianId: 'technician-1', status: 'in_progress' }),
        }),
      });
      const remote: SyncRecord = Object.freeze({
        id: 'inc-immutable',
        version: 2,
        fields: Object.freeze({
          work: Object.freeze({ assignedTechnicianId: 'technician-2', status: 'assigned' }),
        }),
      });

      const baseSnapshot = JSON.stringify(base);
      const localSnapshot = JSON.stringify(local);
      const remoteSnapshot = JSON.stringify(remote);

      resolveSync(base, local, remote);

      expect(JSON.stringify(base)).toBe(baseSnapshot);
      expect(JSON.stringify(local)).toBe(localSnapshot);
      expect(JSON.stringify(remote)).toBe(remoteSnapshot);
    });
  });

  describe('deduplicateOperations algorithm', () => {
    it('preserves first occurrence of duplicated operationId without mutating array', () => {
      const op1 = { operationId: 'op-100', payload: { action: 'start' } };
      const op2 = { operationId: 'op-100', payload: { action: 'start_retry' } };
      const op3 = { operationId: 'op-200', payload: { action: 'comment' } };
      const op4 = { operationId: 'op-100', payload: { action: 'start_third_time' } };

      const input = [op1, op2, op3, op4];
      const snapshot = JSON.stringify(input);

      const result = deduplicateOperations(input);

      expect(result).toEqual([op1, op3]);
      expect(result[0]).toBe(op1);
      expect(result[1]).toBe(op3);
      expect(JSON.stringify(input)).toBe(snapshot);
    });

    it('handles empty or already unique operations cleanly', () => {
      expect(deduplicateOperations([])).toEqual([]);

      const single = [{ operationId: 'op-only', val: 1 }];
      expect(deduplicateOperations(single)).toEqual(single);
    });
  });
});
