/**
 * Tests for the SQLite database adapter
 */

// Force SQLite mode
process.env.DB_MODE = 'sqlite';

const db = require('../database/sqlite');

describe('SQLite Database Adapter', () => {
  beforeAll(async () => {
    await db.initializeDatabase();
  });

  describe('Users', () => {
    it('should return undefined for a non-existent user', async () => {
      const user = await db.getUser('nonexistent@example.com');
      expect(user).toBeUndefined();
    });

    it('should create a new user', async () => {
      const user = await db.createUser('test@example.com');
      expect(user).toBeDefined();
      expect(user.email).toBe('test@example.com');
      expect(user.created_at).toBeDefined();
    });

    it('should retrieve an existing user', async () => {
      const user = await db.getUser('test@example.com');
      expect(user).toBeDefined();
      expect(user.email).toBe('test@example.com');
    });

    it('should not fail when creating a duplicate user (INSERT OR IGNORE)', async () => {
      const user = await db.createUser('test@example.com');
      expect(user).toBeDefined();
      expect(user.email).toBe('test@example.com');
    });
  });

  describe('Clients', () => {
    let clientId;

    it('should return empty array when no clients exist for user', async () => {
      const clients = await db.getClientsByUser('noclient@example.com');
      expect(clients).toEqual([]);
    });

    it('should create a client', async () => {
      const client = await db.createClient({
        name: 'Acme Corp',
        description: 'A test client',
        department: 'Engineering',
        email: 'acme@example.com',
        user_email: 'test@example.com'
      });
      expect(client).toBeDefined();
      expect(client.id).toBeDefined();
      expect(client.name).toBe('Acme Corp');
      expect(client.description).toBe('A test client');
      expect(client.department).toBe('Engineering');
      expect(client.email).toBe('acme@example.com');
      expect(client.user_email).toBe('test@example.com');
      expect(client.created_at).toBeDefined();
      expect(client.updated_at).toBeDefined();
      clientId = client.id;
    });

    it('should create a client with minimal fields', async () => {
      const client = await db.createClient({
        name: 'Minimal Client',
        user_email: 'test@example.com'
      });
      expect(client).toBeDefined();
      expect(client.name).toBe('Minimal Client');
      expect(client.description).toBeNull();
      expect(client.department).toBeNull();
      expect(client.email).toBeNull();
    });

    it('should get a client by id', async () => {
      const client = await db.getClientById(clientId);
      expect(client).toBeDefined();
      expect(client.id).toBe(clientId);
      expect(client.name).toBe('Acme Corp');
    });

    it('should return undefined for non-existent client id', async () => {
      const client = await db.getClientById('non-existent-id');
      expect(client).toBeUndefined();
    });

    it('should get all clients for a user', async () => {
      const clients = await db.getClientsByUser('test@example.com');
      expect(clients.length).toBeGreaterThanOrEqual(2);
      expect(clients.some(c => c.name === 'Acme Corp')).toBe(true);
    });

    it('should update a client', async () => {
      const updated = await db.updateClient(clientId, {
        name: 'Acme Corp Updated',
        description: 'Updated description',
        department: 'Sales',
        email: 'updated@acme.com'
      });
      expect(updated).toBeDefined();
      expect(updated.name).toBe('Acme Corp Updated');
      expect(updated.description).toBe('Updated description');
      expect(updated.department).toBe('Sales');
      expect(updated.email).toBe('updated@acme.com');
    });

    it('should partially update a client', async () => {
      const updated = await db.updateClient(clientId, {
        name: 'Acme Corp Partial'
      });
      expect(updated).toBeDefined();
      expect(updated.name).toBe('Acme Corp Partial');
      expect(updated.description).toBe('Updated description');
    });

    it('should delete a client and its work entries', async () => {
      // Create a client to delete
      const client = await db.createClient({
        name: 'To Delete',
        user_email: 'test@example.com'
      });
      // Create a work entry for this client
      await db.createWorkEntry({
        client_id: client.id,
        user_email: 'test@example.com',
        hours: 2,
        description: 'test',
        date: '2024-01-01'
      });

      await db.deleteClient(client.id);

      const deleted = await db.getClientById(client.id);
      expect(deleted).toBeUndefined();

      // Work entries should also be deleted
      const entries = await db.getWorkEntriesByClient(client.id);
      expect(entries).toEqual([]);
    });
  });

  describe('Work Entries', () => {
    let entryId;
    let testClientId;

    beforeAll(async () => {
      const client = await db.createClient({
        name: 'Work Entry Test Client',
        user_email: 'worker@example.com'
      });
      testClientId = client.id;
      await db.createUser('worker@example.com');
    });

    it('should return empty array when no work entries exist for user', async () => {
      const entries = await db.getWorkEntriesByUser('noentries@example.com');
      expect(entries).toEqual([]);
    });

    it('should return empty array when no work entries exist for client', async () => {
      const entries = await db.getWorkEntriesByClient('non-existent-client');
      expect(entries).toEqual([]);
    });

    it('should create a work entry', async () => {
      const entry = await db.createWorkEntry({
        client_id: testClientId,
        user_email: 'worker@example.com',
        hours: 8,
        description: 'Development work',
        date: '2024-06-15'
      });
      expect(entry).toBeDefined();
      expect(entry.id).toBeDefined();
      expect(entry.client_id).toBe(testClientId);
      expect(entry.user_email).toBe('worker@example.com');
      expect(entry.hours).toBe(8);
      expect(entry.description).toBe('Development work');
      expect(entry.date).toBe('2024-06-15');
      expect(entry.created_at).toBeDefined();
      expect(entry.updated_at).toBeDefined();
      entryId = entry.id;
    });

    it('should create a work entry with null description', async () => {
      const entry = await db.createWorkEntry({
        client_id: testClientId,
        user_email: 'worker@example.com',
        hours: 4,
        date: '2024-06-16'
      });
      expect(entry).toBeDefined();
      expect(entry.description).toBeNull();
    });

    it('should get a work entry by id', async () => {
      const entry = await db.getWorkEntryById(entryId);
      expect(entry).toBeDefined();
      expect(entry.id).toBe(entryId);
      expect(entry.hours).toBe(8);
    });

    it('should return undefined for non-existent work entry id', async () => {
      const entry = await db.getWorkEntryById('non-existent-id');
      expect(entry).toBeUndefined();
    });

    it('should get work entries by user', async () => {
      const entries = await db.getWorkEntriesByUser('worker@example.com');
      expect(entries.length).toBeGreaterThanOrEqual(2);
    });

    it('should get work entries by client', async () => {
      const entries = await db.getWorkEntriesByClient(testClientId);
      expect(entries.length).toBeGreaterThanOrEqual(2);
    });

    it('should update a work entry', async () => {
      const updated = await db.updateWorkEntry(entryId, {
        hours: 10,
        description: 'Updated description',
        date: '2024-06-17',
        client_id: testClientId
      });
      expect(updated).toBeDefined();
      expect(updated.hours).toBe(10);
      expect(updated.description).toBe('Updated description');
      expect(updated.date).toBe('2024-06-17');
    });

    it('should partially update a work entry', async () => {
      const updated = await db.updateWorkEntry(entryId, {
        hours: 5
      });
      expect(updated).toBeDefined();
      expect(updated.hours).toBe(5);
      expect(updated.description).toBe('Updated description');
    });

    it('should delete a work entry', async () => {
      const entry = await db.createWorkEntry({
        client_id: testClientId,
        user_email: 'worker@example.com',
        hours: 1,
        date: '2024-06-18'
      });

      await db.deleteWorkEntry(entry.id);

      const deleted = await db.getWorkEntryById(entry.id);
      expect(deleted).toBeUndefined();
    });
  });
});
