/**
 * Tests for the database index module (mode switching)
 */

describe('Database Index - Mode Selection', () => {
  beforeEach(() => {
    // Clear module cache so we can re-require with different env
    jest.resetModules();
  });

  it('should default to sqlite when DB_MODE is not set', () => {
    delete process.env.DB_MODE;
    const db = require('../database/index');
    // SQLite module exports initializeDatabase, DynamoDB does not
    expect(db.initializeDatabase).toBeDefined();
  });

  it('should use sqlite when DB_MODE is "sqlite"', () => {
    process.env.DB_MODE = 'sqlite';
    const db = require('../database/index');
    expect(db.initializeDatabase).toBeDefined();
  });

  it('should use dynamodb when DB_MODE is "dynamodb"', () => {
    process.env.DB_MODE = 'dynamodb';
    const db = require('../database/index');
    // DynamoDB module does not export initializeDatabase
    expect(db.initializeDatabase).toBeUndefined();
    // But it should still export the standard interface
    expect(db.getUser).toBeDefined();
    expect(db.createUser).toBeDefined();
    expect(db.getClientsByUser).toBeDefined();
    expect(db.createClient).toBeDefined();
    expect(db.createWorkEntry).toBeDefined();
  });

  afterAll(() => {
    // Reset to sqlite for other tests
    process.env.DB_MODE = 'sqlite';
  });
});
