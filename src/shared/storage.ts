// Owned by Person C. Stub — implement in Phase 1.
import type { Feature } from './types';

export const Storage = {
  async list(): Promise<Feature[]> { throw new Error('not implemented'); },
  async get(_id: string): Promise<Feature | null> { throw new Error('not implemented'); },
  async add(_input: Omit<Feature, 'id' | 'createdAt'>): Promise<Feature> { throw new Error('not implemented'); },
  async update(_id: string, _patch: Partial<Feature>): Promise<void> { throw new Error('not implemented'); },
  async remove(_id: string): Promise<void> { throw new Error('not implemented'); },
  async matching(_url: string): Promise<Feature[]> { throw new Error('not implemented'); },
};
